// The few node:test and node:assert declarations the tests use, so they
// type-check without pulling @types/node into a GJS project.

declare module 'node:test' {
    export function describe(name: string, body: () => void): void;
    export function it(name: string, body: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
    interface Assert {
        (value: unknown, message?: string): asserts value;
        equal<T>(actual: T, expected: T, message?: string): void;
        notEqual<T>(actual: T, expected: T, message?: string): void;
        deepEqual<T>(actual: T, expected: T, message?: string): void;
        ok(value: unknown, message?: string): asserts value;
        throws(block: () => unknown, expected?: RegExp, message?: string): void;
    }
    const assert: Assert;
    export default assert;
}
