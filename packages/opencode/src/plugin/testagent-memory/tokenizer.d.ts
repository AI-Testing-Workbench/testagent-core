/**
 * jieba-based tokenizer for accurate Chinese word segmentation.
 *
 * Tokens are lowercased and filtered for stop words.
 */
export declare function buildFtsTokens(raw: string, isQuery: boolean, keepDuplicates?: boolean): string[];
/**
 * Multi-granularity Chinese tokenizer: words + bigrams + single characters.
 * Kept for vector embedding where dense token coverage improves hashing.
 */
export declare function chineseTokenizer(text: string): string[];
