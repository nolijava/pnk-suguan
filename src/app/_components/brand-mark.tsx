/**
 * The PNK Suguan system logo mark.
 *
 * The artwork is HAND-SUPPLIED at `public/logo/` — the generator renders to a
 * scratch dir and refuses to touch it. Both theme variants are shipped: the
 * two SVGs are pixel-identical except for the tiny "PNK" wordmark inside the
 * removed lower-right quadrant (deep navy #1B2A6B on light, near-white
 * #E8EAED on dark). Both <img>s are rendered and CSS picks one per
 * `data-theme`, so there is no flash on first paint and no client JS; the
 * mark's own navy mosaic stays identical in both themes.
 *
 * Decorative by contract — every place it appears is next to the product name
 * in text, so it is hidden from assistive tech instead of doubling the name.
 */
export function BrandMark() {
  return (
    <span className="brand-mark brand-mark-logo" aria-hidden="true">
      <img src="/logo/pnk-suguan-logo.svg" alt="" className="brand-mark-img-light" />
      <img src="/logo/pnk-suguan-logo-dark.svg" alt="" className="brand-mark-img-dark" />
    </span>
  );
}
