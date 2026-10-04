import { TOOL } from "./toolNames.js";

/**
 * The weekly inventory review prompt, as a pure function.
 *
 * Kept apart from server registration so the rendered workflow can be asserted
 * directly — as e2e prompt tests it was only checkable through a live session,
 * and the scoping rules below are exactly the kind of thing that silently
 * rots when nobody can call it in isolation.
 *
 * The `category` argument scopes **every** step, not just the catalog listing:
 * each of the three analytics tools accepts a category filter, so a scoped run
 * produces numbers that are actually scoped. There is deliberately no
 * disclosure note here — an earlier version let the argument narrow only step 1
 * while three catalog-wide steps ran unscoped, and papered over the gap with a
 * disclaimer telling the reader to relabel the figures themselves. The gap is
 * now closed instead of described.
 */
export interface ReviewPromptArgs {
  category?: string | undefined;
}

interface Step {
  tool: string;
  arguments: Record<string, unknown>;
}

export function renderWeeklyReview(args: ReviewPromptArgs): string {
  // Blank is not a category, so it must not become one: `category: "  "` must
  // render the same review as the argumentless run, not one titled `in the
  // "  " category`.
  const scope = args.category?.trim();
  const scoped = Boolean(scope);

  // An ordered workflow, deliberately not a mirror of the tool registry: the
  // review only needs these steps, and a scoped run prepends the catalog
  // listing so the reviewer can see which SKUs are in scope.
  //
  // Each step carries the exact arguments to call it with. Listing bare tool
  // names read as "call these, somehow" — and a step without its arguments
  // would leave the scoping up to the client's imagination.
  const steps: Step[] = scoped
    ? [
        { tool: TOOL.listAllProducts, arguments: { category: scope } },
        { tool: TOOL.lowStockAlerts, arguments: { category: scope } },
        { tool: TOOL.restockPredictor, arguments: { category: scope } },
        { tool: TOOL.salesMetrics, arguments: { category: scope } },
      ]
    : [
        { tool: TOOL.lowStockAlerts, arguments: {} },
        { tool: TOOL.restockPredictor, arguments: {} },
        { tool: TOOL.salesMetrics, arguments: {} },
      ];

  // Say out loud what the scope is: the server now enforces it, but the
  // reader still needs to know that the numbers behind this review are the
  // category's numbers rather than the whole catalog's.
  const scopeNote = scoped
    ? `Scope: every step below is filtered to the "${scope}" category.\n\n`
    : "";

  return (
    `Run the weekly inventory review${scoped ? ` in the "${scope}" category` : ""}.\n\n` +
    `Call these tools in order, with these arguments:\n` +
    steps.map((s, i) => `${i + 1}. \`${s.tool}\` ${JSON.stringify(s.arguments)}`).join("\n") +
    `\n\n${scopeNote}` +
    `Then write the review:\n` +
    "- What ran out first: the top entries of the restock plan, in the order returned — each is already " +
    "ranked by days of cover, so the first item is the one that runs out soonest.\n" +
    "- What to order: the recommended reorder quantity for each, and the demand velocity behind it.\n" +
    "- Which of those are urgent vs. routine, using days of cover (null means no measurable demand, " +
    "so treat it as a merchandising question rather than a stockout).\n" +
    "- Direction of travel from the trend: recent vs. previous revenue and units, and whether the " +
    "series is rising or falling. A flat total with a rising series is not the same story.\n" +
    "- Anything the numbers cannot answer, stated plainly rather than guessed."
  );
}
