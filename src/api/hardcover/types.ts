/**
 * What a Hardcover response carries, narrowed to what is read. Written from
 * live responses rather than from the published schema, the way
 * `simkl/types.ts` is: every field is optional because the payload is
 * upstream's and `noUncheckedIndexedAccess` is on.
 */

/**
 * A cover. `ratio` is in the schema and is **0** on every edition measured, so
 * the shape is computed from the two dimensions, which are populated.
 */
export interface HardcoverImage {
  url?: string;
  width?: number;
  height?: number;
}

/**
 * One published edition of a book. The cover hangs off the edition rather than
 * the book, which is the whole reason this upstream is worth asking: a book's
 * own default cover is one edition's, and rarely the best one.
 */
export interface HardcoverEdition {
  /** How many readers hold this edition. Hardcover publishes no rating for a cover. */
  users_count?: number;
  /** `reading_formats`: 1 Read, 2 Listened, 3 Both, 4 Ebook. Shown, never ranked on. */
  reading_format_id?: number;
  language?: { code2?: string } | null;
  country?: { code2?: string } | null;
  image?: HardcoverImage | null;
}

/**
 * The two orderings of one book's editions, aliased in a single request.
 * Either may be absent: a book with no edition carrying a cover answers with
 * empty lists, not with an error.
 */
export interface HardcoverEditions {
  byUsers?: HardcoverEdition[];
  byWidth?: HardcoverEdition[];
}

/**
 * The GraphQL envelope. A rejected query comes back **200** with `errors`
 * populated and `data` absent, so nothing here may be read without checking
 * both — see `client.ts`.
 */
export interface GraphqlBody<T> {
  data?: T;
  errors?: { message?: string }[];
  error?: string;
}
