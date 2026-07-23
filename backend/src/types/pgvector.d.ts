declare module 'pgvector' {
  export function toSql(embedding: number[]): string;
  export function fromSql(value: string): number[];
}
