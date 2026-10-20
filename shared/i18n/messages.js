// Descriptors contain display data only; never pass arbitrary Error objects.
export function messageDescriptor(key, params = {}) {
  if (typeof key !== "string" || !/^[A-Za-z][\w-]*:[\w.-]+$/.test(key))
    throw new TypeError("Invalid message key");
  const safe = {};
  for (const [name, value] of Object.entries(params)) {
    if (
      !/^[A-Za-z]\w*$/.test(name) ||
      !["string", "number", "boolean"].includes(typeof value) ||
      (typeof value === "number" && !Number.isFinite(value))
    )
      throw new TypeError("Invalid message parameter");
    safe[name] = typeof value === "string" ? value.slice(0, 4096) : value;
  }
  return { key, params: safe };
}
