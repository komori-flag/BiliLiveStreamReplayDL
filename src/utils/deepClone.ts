/**
 * 深拷贝对象或数组。
 * - 保留函数引用（不复制函数闭包）
 * - 处理循环引用
 * - 有最大遍历深度保护，超出时抛错
 * @param obj 要拷贝的对象
 * @param hash 内部使用的循环引用缓存
 * @param depth 剩余最大遍历深度，超限抛错
 * @returns 拷贝后的对象
 */
function deepClone<T>(obj: T, hash: WeakMap<object, any> = new WeakMap(), depth: number = 200): T {
    // 深度保护：防止递归爆栈
    if (depth <= 0) {
        throw new Error(
            `deepClone: 已达到最大遍历深度限制 (${depth})，` +
            `疑似对象嵌套过深或存在未检测到的循环引用`
        );
    }

    // 非对象（包括函数）直接返回
    if (obj === null || typeof obj !== 'object') {
        // 保留函数引用
        if (typeof obj === 'function') return obj;
        return obj;
    }

    // 处理循环引用
    if (hash.has(obj)) return hash.get(obj);

    // 判断类型（数组或普通对象）
    const clone: Record<string, any> | any[] = Array.isArray(obj) ? [] : {};
    hash.set(obj, clone);

    // 遍历属性（仅处理自身可枚举属性，避免原型链属性混入）
    for (const key in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
        // @ts-expect-error: 注意 obj[key] 的类型在 JS 中推断为 any
        clone[key] = deepClone(obj[key], hash, depth - 1);
    }

    return clone as T;
}

export default deepClone;