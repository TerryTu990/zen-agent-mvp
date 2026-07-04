/**
 * JSON 可序列化值域（U1 的类型落点）：端口与消息帧的出入参一律收敛到本类型族，
 * 结构上排除 Date/Map/函数/类实例等不可跨进程序列化的值。
 */
export type JsonPrimitive = string | number | boolean | null;

export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };
