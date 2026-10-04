import { z } from "zod";

import type { productCopySchema } from "./schemas.js";
import type { Product } from "./types.js";

/**
 * Marketing copy generation for a product.
 *
 * The voice tables below are data, not logic, and they live here because this
 * module is their only reader. They used to sit inside the catch-all
 * `analytics.ts` alongside velocity math and order validation, where a copy
 * tweak meant reading a file that had nothing else to do with copy.
 */

const CATEGORY_VOICE: Record<string, string> = {
  tech: "engineered for people who expect their gear to keep up",
  apparel: "made to be worn, washed, and worn again for years",
  home: "designed to make everyday rituals feel a little more considered",
};

const DEFAULT_VOICE = "built with care, down to the last detail";

/**
 * Per-tag voice fragments, keyed by the tags the catalog actually carries.
 *
 * Before this, every product in a category got the identical sentence — the
 * copy generator's flattest output, and the one thing a reader notices: five
 * tech products, five copies that differ only in the product name. A fragment
 * lets the copy say something specific instead ("every keystroke lands with a
 * click you can feel"), and products carrying a tag with no entry simply skip
 * the clause rather than inventing a claim the catalog never made.
 *
 * Phrases are written lowercase and unpunctuated so they can slot in after an
 * em dash in the headline, or be capitalised into standalone sentences in the
 * body. Selection follows the order tags appear on the product — the catalog
 * lists the defining attribute first — which keeps output deterministic with no
 * random pick to make tests flaky.
 */
const TAG_VOICE: Record<string, string> = {
  // tech
  audio: "tuned for the commute, the flight, and everything in between",
  "noise-cancelling": "so the open-plan office finally goes quiet",
  wireless: "with no cable to snag, lose, or forget",
  bluetooth: "pairs once and stays paired",
  wearable: "light enough to forget you are wearing it",
  fitness: "built to survive the session and the shower after it",
  "health-tracking": "turns a good night's sleep into something you can actually read",
  gps: "finds you before you have to wonder where you are",
  storage: "carries a working library in a pocket",
  "usb-c": "one cable for charging and everything else",
  portable: "goes wherever the laptop bag does",
  mechanical: "every keystroke lands with a click you can feel",
  "hot-swappable": "swap the switches when your taste changes, not the keyboard",
  peripherals: "the part of the desk your hands touch all day",
  video: "flattering in a hotel room and sharp in a meeting",
  streaming: "holds up at full bitrate, not just in the demo",
  "4k": "sharp enough that the crop still reads as deliberate",
  // apparel
  wool: "breathes in the cold and never holds a smell",
  outerwear: "the layer that actually gets worn every day",
  winter: "warm without the bulk that ruins a good coat",
  denim: "gets better the more you wear it",
  casual: "goes with whatever is already on",
  footwear: "carries you from the first mile to the last errand",
  running: "responsive where the foot lands and quiet where it does not",
  athletic: "wicks, dries, and does not announce itself",
  cotton: "soft on the first wear and still soft on the fiftieth",
  basics: "the reliable one you reach for without thinking",
  organic: "grown without the compromise",
  // home
  kitchen: "belongs on the counter, not in a cupboard",
  coffee: "the twenty minutes of the day worth slowing down for",
  ceramic: "hand-glazed, so no two are quite the same",
  cookware: "the pan that ends up in every recipe",
  "cast-iron": "heirloom weight, ready for the next hundred years",
  textiles: "the texture that makes a room feel finished",
  linen: "gets softer with every wash and never looks precious",
  "living-room": "makes the corner of the room worth sitting in",
  wellness: "a small ritual that earns its place",
  aromatherapy: "fills the room without dominating it",
  electronics: "quiet enough to forget it is running",
};

/** Fragments for the tags this product carries, in catalog order. */
function tagFragments(product: Product): string[] {
  return product.tags
    .map((tag) => TAG_VOICE[tag.trim().toLowerCase()])
    .filter((phrase): phrase is string => phrase !== undefined);
}

const capitalise = (phrase: string): string => phrase.charAt(0).toUpperCase() + phrase.slice(1);

/** Generate category-aware marketing copy and SEO tags for a product. */
export function buildProductCopy(
  product: Product,
  criticalThreshold: number
): z.infer<typeof productCopySchema> {
  const categoryVoice = CATEGORY_VOICE[product.category.toLowerCase()] ?? DEFAULT_VOICE;
  const fragments = tagFragments(product);

  // The headline leads with the most specific voice the catalog supports: a
  // tag fragment beats the category line, which beats the generic fallback.
  const voice = fragments[0] ?? categoryVoice;

  // The headline already spent the first fragment, so the body runs through the
  // rest — each phrase is used exactly once rather than echoed.
  const tagSentences = fragments.slice(1).map((phrase) => `${capitalise(phrase)}. `).join("");

  const longDescription =
    `${product.description} Part of our ${product.category} lineup, the ${product.name} is ${categoryVoice}. ` +
    tagSentences +
    `Every detail — from ${product.tags[0] ?? "materials"} to everyday durability — was chosen so this earns a ` +
    `permanent spot in your routine, not just a place in your cart.`;

  return {
    sku: product.sku,
    productId: product.id,
    copy: {
      headline: `${product.name} — ${voice}`,
      shortDescription: product.description,
      longDescription,
      bulletPoints: [
        `Category: ${product.category}`,
        `Key attributes: ${product.tags.join(", ")}`,
        `Priced at $${product.price.toFixed(2)}`,
        product.inventoryCount < criticalThreshold
          ? "Limited stock available — won't last long"
          : "In stock and ready to ship",
      ],
    },
    seoTags: [...new Set([...product.tags, product.category, product.name.toLowerCase()])],
  };
}
