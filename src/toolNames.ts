/**
 * Tool names, declared once.
 *
 * `registerTool` owns each name, and the review prompt has to name tools again,
 * and error messages point callers at other tools. Spelling a name twice as a
 * literal meant a renamed tool still compiled while every second mention kept
 * pointing at a name the server no longer answers to — a prompt would instruct
 * a client to call a tool that no longer existed, and an error message would
 * send it to a ghost. Every call site now reads this one constant.
 */
export const TOOL = {
  listAllProducts: "list_all_products",
  lowStockAlerts: "get_low_stock_alerts",
  salesMetrics: "analyze_sales_metrics",
  findOrders: "find_orders",
  restockPredictor: "smart_restock_predictor",
  productCopy: "draft_product_copy",
  orderPlacement: "simulate_order_placement",
  resetState: "reset_demo_state",
} as const;
