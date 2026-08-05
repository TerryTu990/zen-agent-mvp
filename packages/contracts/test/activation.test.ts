import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { ActivationRequest, ActivationResponse } from '../src/index.js';

const schemasDir = new URL('../schemas/', import.meta.url).pathname;
const schemaId = 'https://zen-agent.dev/schema/activation/v1.json';

const ajv = new Ajv2020({ strict: true });
ajv.addSchema(JSON.parse(readFileSync(join(schemasDir, 'activation.schema.json'), 'utf8')) as object);

function validatorOf(uri: string): ValidateFunction {
  const validate = ajv.getSchema(uri);
  if (validate === undefined) throw new Error(`schema 缺 ${uri}`);
  return validate;
}

const validateRoot = validatorOf(schemaId);
const validateRequest = validatorOf(`${schemaId}#/$defs/request`);
const validateResponse = validatorOf(`${schemaId}#/$defs/response`);

const anonDigest = 'a'.repeat(43);
const compactJws = 'header.payload.signature';

const validRequest: ActivationRequest = { installId: '11111111-2222-4333-8444-555555555555' };
const validResponse: ActivationResponse = {
  token: compactJws,
  expiresAt: 1780000000,
  hostUserId: `anon-${anonDigest}`,
};

describe('activation 请求（POST /v1/activation 上行）', () => {
  it('UUID 形态 installId 通过校验', () => {
    expect(validateRequest(validRequest), JSON.stringify(validateRequest.errors)).toBe(true);
  });

  it('多余字段被拒（闭集）', () => {
    expect(validateRequest({ ...validRequest, deviceName: 'mac' })).toBe(false);
  });

  it('缺 installId 被拒', () => {
    expect(validateRequest({})).toBe(false);
  });

  it.each([
    ['空串', ''],
    ['短于下界（31 字符）', 'b'.repeat(31)],
    ['长于上界（129 字符）', 'b'.repeat(129)],
    ['含 charset 外字符', `${'b'.repeat(31)}.`],
    ['含空白', `${'b'.repeat(31)} `],
  ])('installId %s 被拒', (_label, installId) => {
    expect(validateRequest({ installId })).toBe(false);
  });

  it.each([
    ['下界 32 字符', 'b'.repeat(32)],
    ['上界 128 字符', 'b'.repeat(128)],
  ])('installId %s 通过', (_label, installId) => {
    expect(validateRequest({ installId }), JSON.stringify(validateRequest.errors)).toBe(true);
  });

  it('installId 非字符串被拒', () => {
    expect(validateRequest({ installId: 42 })).toBe(false);
  });
});

describe('activation 响应（POST /v1/activation 下行）', () => {
  it('合法响应通过校验', () => {
    expect(validateResponse(validResponse), JSON.stringify(validateResponse.errors)).toBe(true);
  });

  it('多余字段被拒（闭集）', () => {
    expect(validateResponse({ ...validResponse, refreshToken: compactJws })).toBe(false);
  });

  it.each(['token', 'expiresAt', 'hostUserId'] as const)('缺 required %s 被拒', (field) => {
    const { [field]: _omitted, ...rest } = validResponse;
    expect(validateResponse(rest)).toBe(false);
  });

  it.each([
    ['非整数', 1780000000.5],
    ['负数', -1],
    ['字符串形态', '1780000000'],
    // 单位守卫：秒量级取值乘以 1000 即越 2100 年上界，实现若改发毫秒会被契约当场判错。
    ['毫秒量级（单位漂移）', 1780000000000],
  ])('expiresAt %s 被拒', (_label, expiresAt) => {
    expect(validateResponse({ ...validResponse, expiresAt })).toBe(false);
  });

  it('expiresAt 下界 0 通过', () => {
    const candidate = { ...validResponse, expiresAt: 0 };
    expect(validateResponse(candidate), JSON.stringify(validateResponse.errors)).toBe(true);
  });

  it.each([
    ['缺 anon- 前缀', anonDigest],
    ['前缀拼写不符', `anonymous-${anonDigest}`],
    ['摘要短一位', `anon-${'a'.repeat(42)}`],
    ['摘要长一位', `anon-${'a'.repeat(44)}`],
    ['摘要含非 base64url 字符', `anon-${'a'.repeat(42)}+`],
    ['空串', ''],
  ])('hostUserId %s 被拒', (_label, hostUserId) => {
    expect(validateResponse({ ...validResponse, hostUserId })).toBe(false);
  });

  it.each([
    ['非三段', 'header.payload'],
    ['空串', ''],
    ['段内含 charset 外字符', 'header.pay load.signature'],
  ])('token %s 被拒', (_label, token) => {
    expect(validateResponse({ ...validResponse, token })).toBe(false);
  });
});

describe('activation 根 schema 二形态判别', () => {
  it('请求与响应均满足根 oneOf', () => {
    expect(validateRoot(validRequest), JSON.stringify(validateRoot.errors)).toBe(true);
    expect(validateRoot(validResponse), JSON.stringify(validateRoot.errors)).toBe(true);
  });

  it('两形态互不重叠：响应不被当作请求受理', () => {
    expect(validateRequest(validResponse)).toBe(false);
    expect(validateResponse(validRequest)).toBe(false);
  });
});
