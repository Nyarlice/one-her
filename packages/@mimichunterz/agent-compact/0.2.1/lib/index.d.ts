import Schema from '@deepseek-ai/schemastery';
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "tool-context-compression";
export declare const inject: string[];
export interface Config {
    autoArchive: boolean;
    volumeNudgeTokens: number;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): () => void;
