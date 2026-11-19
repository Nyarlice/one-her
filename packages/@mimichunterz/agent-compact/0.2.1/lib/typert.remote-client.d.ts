export declare const TYPERT_REMOTE: {
    package: string;
    descriptors: {
        id: string;
        service: string;
        namespace: string;
        method: string;
        invocation: {
            kind: string;
        };
        parameters: {
            name: string;
            wire: string;
            source: string;
            codec: {
                mode: string;
                typeSymbol: string;
                create: () => import("zod").ZodObject<{
                    sessionId: import("zod").ZodReadonly<import("zod").ZodIntersection<import("zod").ZodString, import("zod").ZodUnknown>>;
                }, import("zod/v4/core").$strip>;
            };
        }[];
        result: {
            mode: string;
            typeSymbol: string;
            create: () => import("zod").ZodReadonly<import("zod").ZodObject<{
                rows: import("zod").ZodReadonly<import("zod").ZodArray<import("zod").ZodObject<{
                    seq: import("zod").ZodReadonly<import("zod").ZodNumber>;
                    type: import("zod").ZodReadonly<import("zod").ZodString>;
                    text: import("zod").ZodReadonly<import("zod").ZodString>;
                    chars: import("zod").ZodReadonly<import("zod").ZodNumber>;
                    tokens: import("zod").ZodOptional<import("zod").ZodReadonly<import("zod").ZodNumber>>;
                    blocks: import("zod").ZodReadonly<import("zod").ZodArray<import("zod").ZodObject<{
                        kind: import("zod").ZodReadonly<import("zod").ZodUnion<readonly [import("zod").ZodLiteral<"text">, import("zod").ZodLiteral<"reasoning">, import("zod").ZodLiteral<"tool-call">, import("zod").ZodLiteral<"tool-result">, import("zod").ZodLiteral<"image">, import("zod").ZodLiteral<"block">]>>;
                        label: import("zod").ZodOptional<import("zod").ZodReadonly<import("zod").ZodString>>;
                        text: import("zod").ZodReadonly<import("zod").ZodString>;
                        chars: import("zod").ZodReadonly<import("zod").ZodNumber>;
                    }, import("zod/v4/core").$strip>>>;
                    source: import("zod").ZodOptional<import("zod").ZodReadonly<import("zod").ZodString>>;
                }, import("zod/v4/core").$strip>>>;
            }, import("zod/v4/core").$strip>>;
        };
        sourceLocation: {
            file: string;
            line: number;
            column: number;
        };
    }[];
};
export default TYPERT_REMOTE;
