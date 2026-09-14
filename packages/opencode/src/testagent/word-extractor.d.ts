// testagent_change - new file
declare module "word-extractor" {
  class ExtractedDocument {
    getBody(): Promise<string> | string
    getFootnotes(): Promise<string> | string
    getHeaders(): Promise<string | string[]> | string | string[]
    getComments(): Promise<string[]> | string[]
    getRawText(): Promise<string> | string
  }
  export default class WordExtractor {
    extract(input: Buffer | string, recover?: boolean): Promise<ExtractedDocument> | ExtractedDocument
  }
}
