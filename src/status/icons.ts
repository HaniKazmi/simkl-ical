/**
 * The status page's icons, carried as constants rather than read from disk. Nothing else here
 * touches the filesystem to answer a request, and three assets of about a kilobyte are cheaper to
 * hold than a static-file handler is to add.
 *
 * They are served under the token, like the feed, so an unauthenticated caller still cannot learn
 * that this host runs anything — the same reason every miss returns one 404 body.
 */

/**
 * Preferred by every current browser and sharp at any size, so it is the only one that has to look
 * right. A calendar because a calendar feed is what this service exists to produce.
 */
export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
<rect width="32" height="32" rx="7" fill="#2f6feb"/>
<rect x="7" y="8.5" width="18" height="16" rx="2.5" fill="#fff"/>
<rect x="7" y="12.5" width="18" height="1.5" fill="#2f6feb"/>
<rect x="13.5" y="17" width="5" height="4.5" rx="1" fill="#2f6feb"/>
</svg>
`;

/** The fallback for a browser too old to take the SVG — Safari before 16. 16, 32 and 48px. */
export const ICON_ICO = Buffer.from(
  'AAABAAMAEBAAAAEAIADLAAAANgAAACAgAAABACAAAQEAAAEBAAAwMAAAAQAgAJUBAAACAgAAiVBORw0KGgoAAAANSUhEUgAA' +
  'ABAAAAAQCAYAAAAf8/9hAAAAkklEQVR42mPQz3/NAMQBQHwfiP8Tie9D9TDANP8nEwcwkGgzhksYKNAMxigGeDa++7/v0s//' +
  'p2//wopBciA1OA2Yvv3rf0IApAavC5Inf8CLaesCZAM+ffsH5oMwiE2yAaBAg4mD2CQb8PTtH7i/QWyiDKhd+olgGIDU4DQA' +
  'hMO63uOMAZActoREcVKmODNRlJ0BVPbS3S6fgmMAAAAASUVORK5CYIKJUE5HDQoaCgAAAA1JSERSAAAAIAAAACAIBgAAAHN6' +
  'evQAAADISURBVHjaY9DPf82AhAWAuAGIzwPxfyrj81CzBZDtRLY8AYjf08BidPweaheKAxLoYDE6ToA5QIBOPscWEgIM0Hj5' +
  'P0C4gYFGCY7ohMkwgJaD8eB3QPLkD/+nb/9KFgbppcgBIEMoBSAzyHbAp2//KHYAyAyyHUAtQFEUUAMP3Vww4FEw6gBcYN+l' +
  'nxhqQWJ0cwC2lI2v0Bp1ANUdACpe0QsbfMX20K0LBrw2HPD2AL3qggFvlA54s3zAOyYD3jUbFJ3TAeueAwAROEpg/wPwzAAA' +
  'AABJRU5ErkJggolQTkcNChoKAAAADUlIRFIAAAAwAAAAMAgGAAAAVwL5hwAAAVxJREFUeNrtmjsOgkAQhvco3EAO4CGovIAH' +
  '0NLGC9hYWNhY6hnsxN7OysRWKzUoiSQ+4sgQMIQAQrK7MGQm+RsgM/PJsrvjrGj1TiJDpq+xL9sXVCQ7zMHMyjPtolFx0nkw' +
  'xj8Ay5dTw+QjOWGOqQBWjRNPykoCGDX/5dPehBEHsAklH/8mRDTbAFGZIpymqAKMqQ6f3zAShJMPxAAkATojB7qTq1ShT+UA' +
  'GGR3eIEqQ99lQQoDtAdnOF7eoNowBsaSDjBcuKDLMJZ0gOnyrg0AYzFA2hDa7J9apGQI8UJWNQB/xAzAAMUAXO8D87UXPB8X' +
  'XsN7tQfIm8OLbkcqBcCtcZYPvMcADNB0gLzgMnxoWQewNEzuMMuUoryQZRX0uqxMYV9qO42rqWrDGErrgf7sBqvtQ3oVhj7R' +
  'Nxc0FAHI/71OvsFBvsVEvsnXiDYr+UZ3I44aNOKwB7njNl/uNWjKcb5vEAAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * iOS home screens. Opaque and square on purpose: iOS composites transparency onto black and lays
 * its own corner mask over the result, so a rounded icon with an alpha channel arrives
 * twice-rounded with black showing in the corners it cut.
 */
export const ICON_APPLE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAADZUlEQVR42u3dO04bURSAYe/IG8gG2AAbYAGhTJOC1i0FDSVp' +
  'kVzRIVqLjgqJFqoEAhZY5iHgJAXKw0ZjPON7Z+539LcePHc+4ceM7V7/83dpZj1LIDgEh+AQHIJDcAgOwSE4BIcEh+AQHIJD' +
  'cAgOwSE4BIfgkOAQHIJDcAgOwSE4BIfgEBwSHIJDcAgOwSE4BIfgEByCQ3BIcAgOwSE4BMe/bWxfdz44Fmhz92Y4ml5cPr0U' +
  'M7Gzscux43DM7eu3cVEmZiqJRYDjrz59+XF89vBifk8sRSwIHL9aH/wcT56Z+HNiQWJZSsextnVFxjwfsTjl4oh/nqfnjxzM' +
  'm1ictI8vKXHsHNwR8P7EEpWII/5nOvZVJuGDSzIce0cTB77KxEIVh8Pz0OrPTMvCEa/THPXqk+plbRocg/1bh7z6xHIVhMPr' +
  'lFa8Zul5Nuo5aV44nElZ9GwLHAYOOOCAAw444IADDjjggAOOjM+tlPCxg7oq69yKfKhJcAgOwSHBITjkfQ7vc3iH1DukcBg4' +
  'DBxwwAEHHHDAAQcccMABBxxwwAEHHHAYOAwccMABBxxwwNExHPGnh6PpzsHdQsVN0t5nOJqdOMZLflt03DzJt5nB0ezU+Dsm' +
  'sSk4uoPj8OS+3vsfG4SjIzhqv0B3xV+yC0eD08QuwAEHHHDAAQcccMABBxxwwAEHHHDAAQcccMABBxxwwAEHHHDAAQcccMDx' +
  '8Vny0tGZF5PC0REcNV5AmuQyUjganIvLpxr/ecSmYoNwdOfq89Pzx1p8xEZiUyu+83A0PuPJ82D/9sMXG8cN4+axkdXfczgM' +
  'HHDAkdWHgto+tX8oK2scST5x2t6J5YLDwJHis8itntrfxMsax9rWlUNefWK5CsIRrf6tpJZOLFSqY5QMh0eWzB9T+ml/AHDF' +
  'ZyjaOLFECQ9QShybuzcO//sTS1QojmjvaELAvInFSXt00v+u7HA05eD/iWVJfmiy+NFhPjKU0c/nF6njwTXJ2fDcJhYh7fOM' +
  'HHG8fctnsS9hYseX/6bUzuJ4a2P7Opbp8OT++Oyh88Vuxs7GLmd4IHLEITgEh+AQHIJDgkNwCA7BITgEh+AQHIJDcAgOCQ7B' +
  'ITgEh+AQHIJDcAgOwSHBITgEh+AQHIJDcAgOwSE4JDgEh+AQHIJDqXsFUGRnc5voOsgAAAAASUVORK5CYII=',
  'base64',
);
