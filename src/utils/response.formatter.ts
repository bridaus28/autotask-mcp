/**
 * Compact Response Formatter
 * Reduces response size for LLM context windows by selecting only essential fields
 * per entity type and providing pagination metadata.
 */

export type EntityType = 'tickets' | 'companies' | 'contacts' | 'projects' | 'tasks' | 'resources' | 'billingItems' | 'billingItemApprovalLevels' | 'timeEntries';

export interface CompactResponse {
  summary: {
    returned: number;
    hasMore: boolean;
    page: number;
    pageSize: number;
    hint?: string;
  };
  items: Record<string, any>[];
}

/**
 * Fields to include in compact responses, per entity type.
 * These are the minimum fields needed for identification and triage.
 */
const SUMMARY_FIELDS: Record<EntityType, string[]> = {
  tickets: ['id', 'ticketNumber', 'title', 'status', 'priority', 'companyID', 'assignedResourceID', 'createDate', 'dueDateTime'],
  companies: ['id', 'companyName', 'isActive', 'phone', 'city', 'state'],
  // middleInitial carries the nickname under the CV convention (2026-07-29);
  // without it here a contact search cannot show what the caller goes by.
  contacts: ['id', 'firstName', 'middleInitial', 'lastName', 'emailAddress', 'companyID'],
  projects: ['id', 'projectName', 'status', 'companyID', 'projectLeadResourceID', 'startDate', 'endDate'],
  tasks: ['id', 'title', 'status', 'projectID', 'assignedResourceID', 'percentComplete'],
  resources: ['id', 'firstName', 'lastName', 'email', 'isActive', 'title', 'officeExtension'],
  billingItems: ['id', 'itemName', 'companyID', 'ticketID', 'projectID', 'postedDate', 'totalAmount', 'invoiceID', 'billingItemType'],
  billingItemApprovalLevels: ['id', 'timeEntryID', 'approvalLevel', 'approvalResourceID', 'approvalDateTime'],
  timeEntries: ['id', 'resourceID', 'ticketID', 'projectID', 'taskID', 'dateWorked', 'hoursWorked', 'summaryNotes'],
};

/**
 * Integer fields that are really picklist references. Autotask returns them as bare
 * integers, so a consumer reading `"status": 5` has to already know that 5 is
 * Complete and 8 is In Progress.
 *
 * Why this exists. 2026-07-31 14:07, conv_...q4f1jxg3jkxs: a ticket search returned
 * T20260623.0036 with `"status": 5`. Ivy told the caller it was "currently in
 * progress with Brian" and filed her brand new request as a note on it. A note on a
 * completed ticket queues no work, nobody called back, and on 2026-08-03 the caller
 * hung up saying she would drive to the office instead. Across the corpus a note has
 * been appended to a ticket just seen as Complete, dated a previous day, 29 times;
 * the stalest was 106 days old.
 *
 * The consumer is already trying to solve this unaided: 93 calls to
 * list_ticket_statuses, list_ticket_priorities, list_queues and get_field_info, 69%
 * of them immediately after a ticket search, detail or create. They exist only to
 * decode an integer just handed over, so labelling here should REMOVE calls.
 *
 * Naming follows the API. Autotask picklist values are `{value, label}` objects, so
 * the added key is always `<apiFieldName>Label`: statusLabel, priorityLabel,
 * queueIDLabel. The suffix is derived in resolveLabelMap rather than written per
 * row, so a later addition cannot invent its own convention. This is a different
 * mechanism from the entity-reference names further down (companyID -> company,
 * assignedResourceID -> assignedTo), which resolve to another record rather than a
 * picklist and keep their existing keys.
 *
 * The label is added BESIDE the integer, never instead of it: writes still take
 * integers (update_ticket {status: 5}, {priority: 1}, {status: 19} all appear in
 * live traffic).
 *
 * Staged deliberately. This is stage 1 and covers ticket status only, the field that
 * caused the incident above, on the highest-traffic search (640 calls). Each later
 * stage is one row here:
 *     stage 2  tickets priority
 *     stage 3  tickets queueID            also needs queueID in SUMMARY_FIELDS
 *     stage 4  get_ticket_details         does not flow through this formatter
 *     stage 5  companies classification   also needs the field in SUMMARY_FIELDS
 *     stage 6  projects/tasks status, billingItems billingItemType
 */
const PICKLIST_LABEL_FIELDS: Partial<Record<EntityType, Array<{ field: string; entity: string }>>> = {
  tickets: [{ field: 'status', entity: 'Tickets' }],
};

/**
 * Supplies picklist values for an entity/field pair. Injected rather than imported so
 * this module stays pure and offline-testable, and so a lookup failure degrades to the
 * previous output instead of failing the search.
 */
export type PicklistLabelResolver = (
  entity: string,
  field: string
) => Promise<Array<{ value: string | number; label: string }>>;

type LabelMap = Record<string, { key: string; byValue: Map<string, string> }>;

/** Resolve every picklist label for one entity type. Never throws. */
async function resolveLabelMap(entityType: EntityType, resolve: PicklistLabelResolver): Promise<LabelMap> {
  const spec = PICKLIST_LABEL_FIELDS[entityType];
  const out: LabelMap = {};
  if (!spec) return out;
  await Promise.all(
    spec.map(async ({ field, entity }) => {
      try {
        const values = await resolve(entity, field);
        const byValue = new Map<string, string>();
        for (const v of values || []) {
          if (v?.label != null) byValue.set(String(v.value), String(v.label));
        }
        if (byValue.size > 0) out[field] = { key: `${field}Label`, byValue };
      } catch {
        // A label we cannot resolve is simply not added; the integer still ships.
      }
    })
  );
  return out;
}

/**
 * Pick only the summary fields from an item, inlining any _enhanced names.
 */
function pickSummaryFields(item: Record<string, any>, entityType: EntityType, labels?: LabelMap): Record<string, any> {
  const fields = SUMMARY_FIELDS[entityType];
  const compact: Record<string, any> = {};

  for (const field of fields) {
    if (item[field] !== undefined && item[field] !== null) {
      compact[field] = item[field];
      // Emitted directly after its integer, so `status` is followed by `statusLabel`
      // when the object is read left to right.
      const lab = labels?.[field];
      if (lab) {
        const label = lab.byValue.get(String(item[field]));
        if (label) compact[lab.key] = label;
      }
    }
  }

  // Inline _enhanced names directly into the item (no separate _enhanced object)
  if (item._enhanced) {
    if (item._enhanced.companyName) {
      compact.company = item._enhanced.companyName;
    }
    if (item._enhanced.assignedResourceName) {
      compact.assignedTo = item._enhanced.assignedResourceName;
    }
    if (item._enhanced.resourceName) {
      compact.resourceName = item._enhanced.resourceName;
    }
  }

  return compact;
}

/**
 * Format a list of items into a compact response with pagination metadata.
 */
export async function formatCompactResponse(
  items: Record<string, any>[],
  entityType: EntityType,
  options: { page?: number; pageSize?: number; totalFetched?: number; hint?: string },
  resolvePicklist?: PicklistLabelResolver
): Promise<CompactResponse> {
  const page = options.page || 1;
  const pageSize = options.pageSize || 25;
  const hasMore = items.length >= pageSize;

  // Resolved once per response, not per row. Omitting the resolver reproduces the
  // previous output byte for byte.
  const labels = resolvePicklist ? await resolveLabelMap(entityType, resolvePicklist) : undefined;
  const compactItems = items.map(item => pickSummaryFields(item, entityType, labels));

  const paginationHint = hasMore
    ? `Use page:${page + 1} for more results, or use get_ticket_details/show commands for full data on specific items`
    : undefined;
  const hint = [options.hint, paginationHint].filter(Boolean).join(' | ') || undefined;

  return {
    summary: {
      returned: compactItems.length,
      hasMore,
      page,
      pageSize,
      ...(hint && { hint }),
    },
    items: compactItems,
  };
}

/**
 * Detect entity type from tool name.
 */
export function detectEntityType(toolName: string): EntityType | null {
  // Order matters - check more specific patterns first
  if (toolName.includes('billing_item_approval')) return 'billingItemApprovalLevels';
  if (toolName.includes('billing_item')) return 'billingItems';
  if (toolName.includes('time_entr')) return 'timeEntries';
  if (toolName.includes('ticket')) return 'tickets';
  if (toolName.includes('compan')) return 'companies';
  if (toolName.includes('contact')) return 'contacts';
  if (toolName.includes('project')) return 'projects';
  // Check 'resource' before 'task' — "autotask_search_resources" contains both.
  if (toolName.includes('resource')) return 'resources';
  if (toolName.includes('task')) return 'tasks';
  return null;
}

/**
 * List of search tool names that should use compact formatting.
 */
export const COMPACT_SEARCH_TOOLS = new Set([
  'autotask_search_tickets',
  'autotask_search_companies',
  'autotask_search_contacts',
  'autotask_search_projects',
  'autotask_search_tasks',
  'autotask_search_resources',
  'autotask_search_billing_items',
  'autotask_search_billing_item_approval_levels',
  'autotask_search_time_entries',
]);
