export interface Verse {
  book: string;
  chapter: number;
  verse: number;
  text: string;
  version: string;
  split_index?: number;
  total_splits?: number;
  score?: number;
}
