/**
 * 平台契约版本——pack.engines.contract（semver range）载入期比对的基准值。
 * 契约面 U3 加法演进递增 minor/patch；破坏性变更递增 major（正常不应出现）。
 */
import semver from 'semver';

export const contractVersion = '1.0.0';

export type ContractCompatibility =
  | { compatible: true }
  | { compatible: false; reason: 'invalid-range' | 'unsatisfied' };

/**
 * pack.engines.contract 与平台契约版本的比对（载入期拒载判定的机械落点）：
 * range 非法与不满足均返回 compatible=false（fail-closed，reason 供可定位错误）。
 */
export function checkContractCompatibility(range: string): ContractCompatibility {
  if (semver.validRange(range) === null) {
    return { compatible: false, reason: 'invalid-range' };
  }
  return semver.satisfies(contractVersion, range)
    ? { compatible: true }
    : { compatible: false, reason: 'unsatisfied' };
}
