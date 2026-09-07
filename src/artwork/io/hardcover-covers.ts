/**
 * READ — a book's editions that carry a cover. Fetch only; `2-candidates.ts`
 * reduces them.
 *
 * **Two queries in one request**, aliased, because neither ordering alone
 * finds the cover. `users_count desc` buries it: 1984's 1707×2560 is held by
 * three readers and does not appear inside the first two hundred editions.
 * `image.width desc` leads with junk: a 2400×2400 German audiobook square with
 * no readers at all. Merged, the right cover is inside forty of one list or
 * the other.
 *
 * Two is also as generous as this can be. Hardcover refuses more than five
 * top-level fields in a request, and the limits under that ceiling are daily
 * as well as per-minute — a free tier answers 429 at roughly one request a
 * second.
 *
 * The selection set is what a rule reads, plus `reading_format_id`, which no
 * rule reads: it is printed on the tile so a reader can tell a paperback's
 * cover from an ebook's at a glance. Deciding *with* it would be the mistake —
 * an audiobook's cover is already demoted by being square, and a second signal
 * for one fact is a second place it can disagree. Not `edition_format`, which
 * is free text and often blank where this is not. Not `image.ratio`, which is
 * 0 on every edition measured, so the shape comes from `width`/`height`.
 */

import { graphql } from '../../api/hardcover/client.ts';
import type { HardcoverEditions } from '../../api/hardcover/types.ts';

const COVER = 'users_count reading_format_id language { code2 } country { code2 } image { url width height }';

const WHERE = 'where: {book_id: {_eq: $id}, image_id: {_is_null: false}}';

// Two aliases rather than a repeated field name: one operation may not carry
// two root fields called `editions`. A shared string rather than a GraphQL
// fragment, which would have to name the Hasura type and buys nothing here.
const EDITIONS = `query Covers($id: Int!, $limit: Int!) {
  byUsers: editions(${WHERE}, order_by: {users_count: desc}, limit: $limit) { ${COVER} }
  byWidth: editions(${WHERE}, order_by: [{image: {width: desc}}, {users_count: desc}], limit: $limit) { ${COVER} }
}`;

/**
 * Forty per ordering. The obscure books measured hold 25–52 editions with a
 * cover at all, so forty is most of the pool for them and a wide enough window
 * on a popular book's two hundred that both orderings' answers land inside it.
 * Eighty rows before the dedupe, which merged to a mean of 27 distinct covers.
 */
const PER_ORDER = 40;

export const fetchBookCovers = (bookId: number, { signal }: { signal?: AbortSignal } = {}): Promise<HardcoverEditions> =>
  graphql<HardcoverEditions>({
    path: `editions/${bookId}`,
    query: EDITIONS,
    variables: { id: bookId, limit: PER_ORDER },
    component: 'artwork',
    signal,
  });
