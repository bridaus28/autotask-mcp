// Autotask Tool Definitions
// Declarative schema definitions for all MCP tools

import { McpTool } from './tool.handler.js';

export const TOOL_DEFINITIONS: McpTool[] = [
  // Connection testing
  {
    name: 'autotask_test_connection',
    description: 'Test the connection to the Autotask API. Returns success or failure. Not intended for use in normal workflows — use for diagnostics and connectivity checks only.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },

  // Company tools
  {
    name: 'autotask_search_companies',
    description: 'Search for companies (accounts) in Autotask. When id is provided, returns exactly one company record and all other parameters are ignored. When searching by name, searchTerm performs a case-insensitive contains match against companyName only — it does not search address, phone, or other fields. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'Fetch a single company by its Autotask integer ID. When provided, all other parameters are ignored and exactly one company record is returned.'
        },
        searchTerm: {
          type: 'string',
          description: 'Partial or full company name to search for. Performs a contains match against the companyName field only. Do not pass phone numbers, addresses, or other non-name values here.'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active status. Omit to return both active and inactive companies.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 200)',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_company',
    description: 'Create a new company (account) in Autotask. companyName and companyType are required. companyType is a picklist integer — use autotask_get_field_info with entityType "Accounts" to find valid values. ownerResourceID should reference an active resource.',
    inputSchema: {
      type: 'object',
      properties: {
        companyName: {
          type: 'string',
          description: 'Company name'
        },
        companyType: {
          type: 'number',
          description: 'Company type picklist integer ID. Use autotask_get_field_info to find valid values.'
        },
        phone: {
          type: 'string',
          description: 'Company main phone number'
        },
        address1: {
          type: 'string',
          description: 'Street address line 1'
        },
        city: {
          type: 'string',
          description: 'City'
        },
        state: {
          type: 'string',
          description: 'State or province'
        },
        postalCode: {
          type: 'string',
          description: 'Postal or ZIP code'
        },
        ownerResourceID: {
          type: 'number',
          description: 'Resource ID of the account owner. Use autotask_search_resources to find valid resource IDs.'
        },
        isActive: {
          type: 'boolean',
          description: 'Whether the company is active. Defaults to true if omitted.'
        }
      },
      required: ['companyName', 'companyType']
    }
  },
  {
    name: 'autotask_update_company',
    description: 'Update an existing company (account) in Autotask. Only the fields you provide will be changed. id is required. To find a company\'s integer ID, use autotask_search_companies first.',
    inputSchema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The integer ID of the company to update. Required.'
        },
        companyName: {
          type: 'string',
          description: 'New company name'
        },
        phone: {
          type: 'string',
          description: 'Main phone number'
        },
        address1: {
          type: 'string',
          description: 'Street address line 1'
        },
        city: {
          type: 'string',
          description: 'City'
        },
        state: {
          type: 'string',
          description: 'State or province'
        },
        postalCode: {
          type: 'string',
          description: 'Postal or ZIP code'
        },
        isActive: {
          type: 'boolean',
          description: 'Active status'
        }
      },
      required: ['id']
    }
  },

  // Contact tools
  {
    name: 'autotask_search_contacts',
    description: 'Search for contacts in Autotask by phone number or name. Two independent search modes — use only one per call. (1) phone: provide a complete phone number; the server extracts the last 4 digits, queries all three phone fields (phone, mobilePhone, alternatePhone) for candidates, then exact-matches the full number locally — pass only a real phone number, not names or other text. (2) searchTerm: performs a contains match across firstName, lastName, and emailAddress simultaneously — use for name or email lookups when no phone number is available. To fetch a single contact by ID, use autotask_get_contact instead. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full name or email to search for. Performs a contains match across firstName, lastName, and emailAddress. Do not use this for phone number lookups — use the phone parameter instead.'
        },
        phone: {
          type: 'string',
          description: 'A complete phone number to look up. Accepts any standard format (digits, dashes, parens, spaces). The server normalizes and exact-matches against contact phone, mobilePhone, and alternatePhone fields. Pass a real phone number only — not names, company names, or other text.'
        },
        companyID: {
          type: 'number',
          description: 'Filter results to contacts belonging to a specific company by its Autotask integer ID.'
        },
        isActive: {
          type: 'number',
          description: 'Filter by active status. 1 = active contacts only, 0 = inactive contacts only. Omit to return both.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 200)',
          minimum: 1,
          maximum: 200
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_contact',
    description: 'Fetch a single contact by their Autotask integer ID. Use this for the identity lock step — after narrowing candidates from autotask_search_contacts to one confirmed match. Returns the full contact record at data.contact including id, firstName, lastName, emailAddress, companyID, and primaryContact. The id field in the response is the authoritative contactId for the rest of the call.',
    inputSchema: {
      type: 'object',
      properties: {
        contactId: {
          type: 'number',
          description: 'The Autotask integer ID of the contact to retrieve. Required. Copy this exactly from the id field of the search result that produced your candidate — never reconstruct or shorten it.'
        }
      },
      required: ['contactId']
    }
  },
  {
    name: 'autotask_create_contact',
    description: 'Create a new contact in Autotask under an existing company. companyID, firstName, and lastName are required. The contact\'s companyID must reference an active company — use autotask_search_companies to find valid company IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Integer ID of the company this contact belongs to. Required. Must reference an active company.'
        },
        firstName: {
          type: 'string',
          description: 'Contact first name'
        },
        lastName: {
          type: 'string',
          description: 'Contact last name'
        },
        emailAddress: {
          type: 'string',
          description: 'Contact email address'
        },
        phone: {
          type: 'string',
          description: 'Contact primary phone number'
        },
        title: {
          type: 'string',
          description: 'Contact job title'
        }
      },
      required: ['companyID', 'firstName', 'lastName']
    }
  },

  // Ticket tools
  {
    name: 'autotask_search_tickets',
    description: 'Search for tickets in Autotask. searchTerm performs a beginsWith match against ticketNumber only — it accepts ticket number prefixes like "T20260101" and is not a free-text search. Use contactID or companyID to find tickets belonging to a specific person or company. No status filter is applied by default — all tickets are returned unless you filter explicitly. Search results return a condensed ticket record (key fields only, description truncated to 200 chars) — use autotask_get_ticket_details for full content on a specific ticket. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Ticket number prefix to search for (e.g. "T20260101"). Performs a beginsWith match against the ticketNumber field only. Do not pass symptom text, names, or descriptions here — this is a structured identifier field.'
        },
        contactID: {
          type: 'number',
          description: 'Filter tickets by contact integer ID. Returns all tickets where contactID matches. Combine with lastActivityAfter to narrow to recent tickets.'
        },
        companyID: {
          type: 'number',
          description: 'Filter tickets by company integer ID. Returns all tickets for that company regardless of which contact they belong to.'
        },
        status: {
          type: 'number',
          description: 'Filter by a single ticket status integer ID. Use autotask_list_ticket_statuses to find valid IDs for this instance. Omit to return tickets of all statuses.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by the integer ID of the assigned technician resource.'
        },
        unassigned: {
          type: 'boolean',
          description: 'Set to true to return only tickets with no assigned resource. Cannot be combined with assignedResourceID.'
        },
        createdAfter: {
          type: 'string',
          description: 'Return tickets created on or after this date. ISO format: YYYY-MM-DD or full ISO 8601 datetime.'
        },
        createdBefore: {
          type: 'string',
          description: 'Return tickets created on or before this date. ISO format: YYYY-MM-DD or full ISO 8601 datetime.'
        },
        lastActivityAfter: {
          type: 'string',
          description: 'Return tickets with last activity on or after this date. ISO format: YYYY-MM-DD or full ISO 8601 datetime. Useful for finding recently active tickets.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_ticket_details',
    description: 'Get detailed information for a specific ticket by its Autotask integer ID. By default (fullDetails: false) returns an optimized record with description truncated to 500 characters and resolution truncated to 300 characters — sufficient for most uses. Set fullDetails to true to retrieve the complete untruncated record. Use autotask_search_tickets first to find the ticket ID.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'The Autotask integer ID of the ticket to retrieve. Required.'
        },
        fullDetails: {
          type: 'boolean',
          description: 'Whether to return the full untruncated ticket record. Default false returns an optimized record with long text fields truncated.',
          default: false
        }
      },
      required: ['ticketID']
    }
  },
  {
    name: 'autotask_create_ticket',
    description: 'Create a new ticket in Autotask. companyID, title, and description are required. status and priority are picklist integers — use autotask_list_ticket_statuses and autotask_list_ticket_priorities to find valid IDs for this instance. If assignedResourceID is set, assignedResourceRoleID is also required by Autotask. contactID must belong to the same company as companyID.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Integer ID of the company the ticket belongs to. Required.'
        },
        title: {
          type: 'string',
          description: 'Ticket title or summary. Required.'
        },
        description: {
          type: 'string',
          description: 'Full ticket description. Required.'
        },
        status: {
          type: 'number',
          description: 'Ticket status picklist integer ID. Use autotask_list_ticket_statuses to find valid IDs for this Autotask instance.'
        },
        priority: {
          type: 'number',
          description: 'Ticket priority picklist integer ID. Use autotask_list_ticket_priorities to find valid IDs for this Autotask instance.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Integer ID of the technician to assign. If set, assignedResourceRoleID is also required by Autotask.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required by Autotask when assignedResourceID is set.'
        },
        contactID: {
          type: 'number',
          description: 'Integer ID of the contact on this ticket. Must belong to the same company as companyID.'
        }
      },
      required: ['companyID', 'title', 'description']
    }
  },
  {
    name: 'autotask_update_ticket',
    description: 'Update an existing ticket in Autotask. Only the fields you provide will be changed — all other fields remain untouched. ticketId is required. Use autotask_list_ticket_statuses and autotask_list_ticket_priorities to find valid picklist IDs before setting status or priority. If assignedResourceID is set, assignedResourceRoleID is also required.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The Autotask integer ID of the ticket to update. Required.'
        },
        title: {
          type: 'string',
          description: 'New ticket title'
        },
        description: {
          type: 'string',
          description: 'New ticket description. Note: updating this field via the API overwrites any rich text formatting with plain text.'
        },
        status: {
          type: 'number',
          description: 'New status picklist integer ID. Use autotask_list_ticket_statuses to find valid IDs.'
        },
        priority: {
          type: 'number',
          description: 'New priority picklist integer ID. Use autotask_list_ticket_priorities to find valid IDs.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Integer ID of the technician to assign. If set, assignedResourceRoleID is also required.'
        },
        assignedResourceRoleID: {
          type: 'number',
          description: 'Role ID for the assigned resource. Required when assignedResourceID is set.'
        },
        dueDateTime: {
          type: 'string',
          description: 'Due date and time in ISO 8601 format (e.g. 2026-03-15T17:00:00Z). All times are stored in UTC.'
        },
        contactID: {
          type: 'number',
          description: 'Integer ID of the contact on this ticket. Must belong to the same company as the ticket.'
        }
      },
      required: ['ticketId']
    }
  },

  // Time entry tools
  {
    name: 'autotask_create_time_entry',
    description: 'Create a time entry in Autotask against a ticket, task, or project. resourceID, dateWorked, hoursWorked, and summaryNotes are required. Exactly one of ticketID, taskID, or projectID must be provided to associate the entry. dateWorked format is YYYY-MM-DD. All datetime fields are stored in UTC.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketID: {
          type: 'number',
          description: 'Ticket ID to log time against. Provide exactly one of ticketID, taskID, or projectID.'
        },
        taskID: {
          type: 'number',
          description: 'Task ID to log time against. Provide exactly one of ticketID, taskID, or projectID.'
        },
        resourceID: {
          type: 'number',
          description: 'Integer ID of the resource (user) logging the time. Required.'
        },
        dateWorked: {
          type: 'string',
          description: 'Date the work was performed. Format: YYYY-MM-DD. Required.'
        },
        startDateTime: {
          type: 'string',
          description: 'Start date and time in ISO 8601 format.'
        },
        endDateTime: {
          type: 'string',
          description: 'End date and time in ISO 8601 format.'
        },
        hoursWorked: {
          type: 'number',
          description: 'Number of hours worked. Required.'
        },
        summaryNotes: {
          type: 'string',
          description: 'Summary of work performed. Required.'
        },
        internalNotes: {
          type: 'string',
          description: 'Internal notes not visible to clients.'
        }
      },
      required: ['resourceID', 'dateWorked', 'hoursWorked', 'summaryNotes']
    }
  },

  // Project tools
  {
    name: 'autotask_search_projects',
    description: 'Search for projects in Autotask. searchTerm performs a contains match against the project name field. Filter by companyID to find all projects for a specific company, or by projectLeadResourceID to find projects assigned to a specific resource. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full project name to search for. Performs a contains match against the project name field.'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company integer ID. Returns all projects for that company.'
        },
        status: {
          type: 'number',
          description: 'Filter by project status picklist integer ID.'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Filter by the integer ID of the project lead resource.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_project',
    description: 'Create a new project in Autotask. companyID, projectName, and status are required. status is a picklist integer (1=New, 2=In Progress, 5=Complete). startDate and endDate use YYYY-MM-DD format.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Integer ID of the company this project belongs to. Required.'
        },
        projectName: {
          type: 'string',
          description: 'Project name. Required.'
        },
        description: {
          type: 'string',
          description: 'Project description.'
        },
        status: {
          type: 'number',
          description: 'Project status picklist integer (1=New, 2=In Progress, 5=Complete). Required.'
        },
        startDate: {
          type: 'string',
          description: 'Project start date in YYYY-MM-DD format.'
        },
        endDate: {
          type: 'string',
          description: 'Project end date in YYYY-MM-DD format.'
        },
        projectLeadResourceID: {
          type: 'number',
          description: 'Integer ID of the project manager resource.'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated total hours for the project.'
        }
      },
      required: ['companyID', 'projectName', 'status']
    }
  },

  // Resource tools
  {
    name: 'autotask_search_resources',
    description: 'Search for resources (Autotask users — technicians, staff, contractors) in Autotask. searchTerm performs a contains match across firstName, lastName, and email simultaneously. Use isActive to filter to active users only. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full name or email to search for. Performs a contains match across firstName, lastName, and email fields simultaneously.'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active status. True returns only active resources. Omit to return both active and inactive.'
        },
        resourceType: {
          type: 'number',
          description: 'Filter by resource type picklist integer (1=Employee, 2=Contractor, 3=Temporary).'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Ticket Notes tools
  {
    name: 'autotask_get_ticket_note',
    description: 'Get a specific note on a ticket by ticket ID and note ID. Both IDs are required. Use autotask_search_ticket_notes to list notes and find note IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The integer ID of the ticket.'
        },
        noteId: {
          type: 'number',
          description: 'The integer ID of the note to retrieve.'
        }
      },
      required: ['ticketId', 'noteId']
    }
  },
  {
    name: 'autotask_search_ticket_notes',
    description: 'List all notes on a specific ticket. Returns notes in default page size order. Use autotask_get_ticket_note to retrieve a specific note by ID.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The integer ID of the ticket to retrieve notes for. Required.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['ticketId']
    }
  },
  {
    name: 'autotask_create_ticket_note',
    description: 'Add a note to an existing ticket. ticketId and description are required. noteType controls the note category (1=General is the standard choice). publish controls visibility: 1=Internal Only, 2=All Autotask Users, 3=Everyone including client portal. Use autotask_list_ticket_statuses if you also need to update the ticket status after adding the note.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The integer ID of the ticket to add the note to. Required.'
        },
        title: {
          type: 'string',
          description: 'Note title or subject line.'
        },
        description: {
          type: 'string',
          description: 'Note content. Required.'
        },
        noteType: {
          type: 'number',
          description: 'Note type picklist integer. 1=General, 2=Appointment, 3=Task, 4=Ticket, 5=Project, 6=Opportunity. Use 1 (General) for standard call notes.'
        },
        publish: {
          type: 'number',
          description: 'Visibility level. 1=Internal Only, 2=All Autotask Users, 3=Everyone (including client portal). Use 2 for standard internal notes.'
        }
      },
      required: ['ticketId', 'description']
    }
  },

  // Project Notes tools
  {
    name: 'autotask_get_project_note',
    description: 'Get a specific note on a project by project ID and note ID. Both IDs are required. Use autotask_search_project_notes to list notes and find note IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The integer ID of the project.'
        },
        noteId: {
          type: 'number',
          description: 'The integer ID of the note to retrieve.'
        }
      },
      required: ['projectId', 'noteId']
    }
  },
  {
    name: 'autotask_search_project_notes',
    description: 'List all notes on a specific project. Returns notes in default page size order.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The integer ID of the project to retrieve notes for. Required.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['projectId']
    }
  },
  {
    name: 'autotask_create_project_note',
    description: 'Add a note to an existing project. projectId and description are required. noteType controls the note category (1=General is the standard choice).',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'number',
          description: 'The integer ID of the project to add the note to. Required.'
        },
        title: {
          type: 'string',
          description: 'Note title or subject line.'
        },
        description: {
          type: 'string',
          description: 'Note content. Required.'
        },
        noteType: {
          type: 'number',
          description: 'Note type picklist integer. 1=General, 2=Appointment, 3=Task, 4=Ticket, 5=Project, 6=Opportunity.'
        }
      },
      required: ['projectId', 'description']
    }
  },

  // Company Notes tools
  {
    name: 'autotask_get_company_note',
    description: 'Get a specific note on a company by company ID and note ID. Both IDs are required. Use autotask_search_company_notes to list notes and find note IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The integer ID of the company.'
        },
        noteId: {
          type: 'number',
          description: 'The integer ID of the note to retrieve.'
        }
      },
      required: ['companyId', 'noteId']
    }
  },
  {
    name: 'autotask_search_company_notes',
    description: 'List all notes on a specific company. Returns notes in default page size order.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The integer ID of the company to retrieve notes for. Required.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: ['companyId']
    }
  },
  {
    name: 'autotask_create_company_note',
    description: 'Add a note to an existing company record. companyId and description are required.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'The integer ID of the company to add the note to. Required.'
        },
        title: {
          type: 'string',
          description: 'Note title or subject line.'
        },
        description: {
          type: 'string',
          description: 'Note content. Required.'
        },
        actionType: {
          type: 'number',
          description: 'Action type picklist integer for the note. Use autotask_get_field_info to find valid values.'
        }
      },
      required: ['companyId', 'description']
    }
  },

  // Ticket Attachments tools
  {
    name: 'autotask_get_ticket_attachment',
    description: 'Get a specific attachment on a ticket by ticket ID and attachment ID. Both IDs are required. Set includeData to true to retrieve the base64-encoded file content — omit or set false to retrieve metadata only.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The integer ID of the ticket.'
        },
        attachmentId: {
          type: 'number',
          description: 'The integer ID of the attachment to retrieve.'
        },
        includeData: {
          type: 'boolean',
          description: 'Whether to include base64-encoded file content in the response. Default false returns metadata only.',
          default: false
        }
      },
      required: ['ticketId', 'attachmentId']
    }
  },
  {
    name: 'autotask_search_ticket_attachments',
    description: 'List all attachments on a specific ticket. Returns attachment metadata — use autotask_get_ticket_attachment with includeData: true to retrieve file content for a specific attachment.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'number',
          description: 'The integer ID of the ticket to list attachments for. Required.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 10, max: 50)',
          minimum: 1,
          maximum: 50
        }
      },
      required: ['ticketId']
    }
  },

  // Expense Reports tools
  {
    name: 'autotask_get_expense_report',
    description: 'Get a specific expense report by its Autotask integer ID.',
    inputSchema: {
      type: 'object',
      properties: {
        reportId: {
          type: 'number',
          description: 'The integer ID of the expense report to retrieve. Required.'
        }
      },
      required: ['reportId']
    }
  },
  {
    name: 'autotask_search_expense_reports',
    description: 'Search for expense reports in Autotask. Filter by submitter resource ID or status. Returns 25 results per page by default. Status values: 1=New, 2=Submitted, 3=Approved, 4=Paid, 5=Rejected, 6=InReview.',
    inputSchema: {
      type: 'object',
      properties: {
        submitterId: {
          type: 'number',
          description: 'Filter by the integer ID of the submitting resource.'
        },
        status: {
          type: 'number',
          description: 'Filter by status integer (1=New, 2=Submitted, 3=Approved, 4=Paid, 5=Rejected, 6=InReview).'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_expense_report',
    description: 'Create a new expense report in Autotask. submitterId is required. weekEndingDate uses YYYY-MM-DD format. After creating the report, add line items using autotask_create_expense_item.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Expense report name or title.'
        },
        description: {
          type: 'string',
          description: 'Expense report description.'
        },
        submitterId: {
          type: 'number',
          description: 'Integer ID of the resource submitting this expense report. Required.'
        },
        weekEndingDate: {
          type: 'string',
          description: 'Week ending date in YYYY-MM-DD format.'
        }
      },
      required: ['submitterId']
    }
  },

  // Expense Item tools
  {
    name: 'autotask_create_expense_item',
    description: 'Add a line item to an existing expense report. expenseReportId, description, expenseDate, expenseCategory, and amount are required. expenseDate uses YYYY-MM-DD format. expenseCategory is a picklist integer — use autotask_get_field_info to find valid values. companyId defaults to 0 (internal) if not provided.',
    inputSchema: {
      type: 'object',
      properties: {
        expenseReportId: { type: 'number', description: 'The integer ID of the expense report to add this item to. Required.' },
        description: { type: 'string', description: 'Line item description. Required.' },
        expenseDate: { type: 'string', description: 'Date of the expense in YYYY-MM-DD format. Required.' },
        expenseCategory: { type: 'number', description: 'Expense category picklist integer ID. Required. Use autotask_get_field_info to find valid values.' },
        amount: { type: 'number', description: 'Expense amount in the account currency. Required.' },
        companyId: { type: 'number', description: 'Associated company integer ID. Use 0 for internal expenses.' },
        haveReceipt: { type: 'boolean', description: 'Whether a receipt is attached.' },
        isBillableToCompany: { type: 'boolean', description: 'Whether this expense is billable to a client company.' },
        isReimbursable: { type: 'boolean', description: 'Whether this expense is reimbursable to the submitter.' },
        paymentType: { type: 'number', description: 'Payment type picklist integer ID.' }
      },
      required: ['expenseReportId', 'description', 'expenseDate', 'expenseCategory', 'amount']
    }
  },

  // Quotes tools
  {
    name: 'autotask_get_quote',
    description: 'Get a specific quote by its Autotask integer ID.',
    inputSchema: {
      type: 'object',
      properties: {
        quoteId: {
          type: 'number',
          description: 'The integer ID of the quote to retrieve. Required.'
        }
      },
      required: ['quoteId']
    }
  },
  {
    name: 'autotask_search_quotes',
    description: 'Search for quotes in Autotask. Filter by company, contact, or opportunity integer IDs. searchTerm performs a contains match against the quote description field — it does not search quote name or number.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company integer ID.'
        },
        contactId: {
          type: 'number',
          description: 'Filter by contact integer ID.'
        },
        opportunityId: {
          type: 'number',
          description: 'Filter by opportunity integer ID.'
        },
        searchTerm: {
          type: 'string',
          description: 'Partial text to search for. Performs a contains match against the quote description field only.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_quote',
    description: 'Create a new quote in Autotask. companyId is required. effectiveDate and expirationDate use YYYY-MM-DD format.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Quote name or title.'
        },
        description: {
          type: 'string',
          description: 'Quote description.'
        },
        companyId: {
          type: 'number',
          description: 'Integer ID of the company this quote is for. Required.'
        },
        contactId: {
          type: 'number',
          description: 'Integer ID of the contact this quote is addressed to.'
        },
        opportunityId: {
          type: 'number',
          description: 'Integer ID of the associated opportunity.'
        },
        effectiveDate: {
          type: 'string',
          description: 'Quote effective date in YYYY-MM-DD format.'
        },
        expirationDate: {
          type: 'string',
          description: 'Quote expiration date in YYYY-MM-DD format.'
        }
      },
      required: ['companyId']
    }
  },

  // Configuration Item tools
  {
    name: 'autotask_search_configuration_items',
    description: 'Search for configuration items (assets, CIs) in Autotask. searchTerm performs a contains match against the configuration item name. Filter by companyID to find all assets for a specific company, or by productID to find items of a specific product type.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full name to search for. Performs a contains match against the configuration item name field.'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company integer ID. Returns all configuration items for that company.'
        },
        isActive: {
          type: 'boolean',
          description: 'Filter by active status. Omit to return both active and inactive items.'
        },
        productID: {
          type: 'number',
          description: 'Filter by product integer ID.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Contract tools
  {
    name: 'autotask_search_contracts',
    description: 'Search for contracts in Autotask. searchTerm performs a contains match against contract name. Filter by companyID or status. Status values: 1=In Effect, 3=Terminated.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full contract name to search for. Performs a contains match against the contract name field.'
        },
        companyID: {
          type: 'number',
          description: 'Filter by company integer ID.'
        },
        status: {
          type: 'number',
          description: 'Filter by contract status integer (1=In Effect, 3=Terminated).'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Invoice tools
  {
    name: 'autotask_search_invoices',
    description: 'Search for invoices in Autotask. Filter by company integer ID, invoice number string, or voided status. No searchTerm parameter — use invoiceNumber for a specific invoice or companyID to list all invoices for a company.',
    inputSchema: {
      type: 'object',
      properties: {
        companyID: {
          type: 'number',
          description: 'Filter by company integer ID. Returns all invoices for that company.'
        },
        invoiceNumber: {
          type: 'string',
          description: 'Filter by invoice number string for a specific invoice.'
        },
        isVoided: {
          type: 'boolean',
          description: 'Filter by voided status. Omit to return both voided and non-voided invoices.'
        },
        pageSize: {
          type: 'number',
          description: 'Number of results to return (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Task tools
  {
    name: 'autotask_search_tasks',
    description: 'Search for tasks in Autotask. searchTerm performs a contains match against task title. Tasks belong to projects — filter by projectID to find all tasks within a specific project. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        searchTerm: {
          type: 'string',
          description: 'Partial or full task title to search for. Performs a contains match against the task title field.'
        },
        projectID: {
          type: 'number',
          description: 'Filter by project integer ID. Returns all tasks in that project.'
        },
        status: {
          type: 'number',
          description: 'Filter by task status picklist integer (1=New, 2=In Progress, 5=Complete).'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Filter by the integer ID of the assigned resource.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 100)',
          minimum: 1,
          maximum: 100
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_create_task',
    description: 'Create a new task within an existing Autotask project. projectID, title, and status are required. status is a picklist integer (1=New, 2=In Progress, 5=Complete). startDateTime and endDateTime use ISO 8601 format.',
    inputSchema: {
      type: 'object',
      properties: {
        projectID: {
          type: 'number',
          description: 'Integer ID of the project this task belongs to. Required.'
        },
        title: {
          type: 'string',
          description: 'Task title. Required.'
        },
        description: {
          type: 'string',
          description: 'Task description.'
        },
        status: {
          type: 'number',
          description: 'Task status picklist integer (1=New, 2=In Progress, 5=Complete). Required.'
        },
        assignedResourceID: {
          type: 'number',
          description: 'Integer ID of the resource to assign this task to.'
        },
        estimatedHours: {
          type: 'number',
          description: 'Estimated hours to complete the task.'
        },
        startDateTime: {
          type: 'string',
          description: 'Task start date and time in ISO 8601 format.'
        },
        endDateTime: {
          type: 'string',
          description: 'Task end date and time in ISO 8601 format.'
        }
      },
      required: ['projectID', 'title', 'status']
    }
  },

  // Picklist / Queue tools
  {
    name: 'autotask_list_queues',
    description: 'List all ticket queues configured in this Autotask instance. Returns queue integer IDs and names. Use the returned IDs when filtering tickets by queue or assigning tickets to a queue. Queue IDs are instance-specific and vary between Autotask tenants.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_statuses',
    description: 'List all ticket status values configured in this Autotask instance. Returns status integer IDs and names. Status IDs are instance-specific — always query this tool before setting or filtering by ticket status rather than hardcoding IDs. Common statuses include New, In Progress, Complete, and RMM Complete but the exact IDs vary per tenant.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_list_ticket_priorities',
    description: 'List all ticket priority values configured in this Autotask instance. Returns priority integer IDs and names. Priority IDs are instance-specific — always query this tool before setting or filtering by ticket priority rather than hardcoding IDs.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: []
    }
  },
  {
    name: 'autotask_get_field_info',
    description: 'Get field definitions for an Autotask entity type, including all picklist values with their integer IDs and labels. Use this to discover valid values for any picklist field before creating or updating records. entityType must match the Autotask REST API entity name exactly (e.g. "Tickets", "Accounts", "Contacts", "Projects"). Optionally filter to a specific field by name.',
    inputSchema: {
      type: 'object',
      properties: {
        entityType: {
          type: 'string',
          description: 'The Autotask REST API entity type name (e.g. "Tickets", "Accounts", "Contacts", "Projects", "Resources"). Must match the API entity name exactly — note that companies use "Accounts" not "Companies".'
        },
        fieldName: {
          type: 'string',
          description: 'Optional: return information for a specific field only. If omitted, returns a summary of all fields for the entity.'
        }
      },
      required: ['entityType']
    }
  },

  // Billing Items tools
  {
    name: 'autotask_search_billing_items',
    description: 'Search for billing items in Autotask. Billing items represent approved and posted billable entries from the Approve and Post workflow — they are the finalized billable records associated with time entries, expenses, and charges. Filter by company, ticket, project, contract, or invoice integer IDs, or by posted date range. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: {
          type: 'number',
          description: 'Filter by company integer ID.'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket integer ID.'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project integer ID.'
        },
        contractId: {
          type: 'number',
          description: 'Filter by contract integer ID.'
        },
        invoiceId: {
          type: 'number',
          description: 'Filter by invoice integer ID.'
        },
        postedAfter: {
          type: 'string',
          description: 'Return billing items posted on or after this date. ISO format: YYYY-MM-DD.'
        },
        postedBefore: {
          type: 'string',
          description: 'Return billing items posted on or before this date. ISO format: YYYY-MM-DD.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },
  {
    name: 'autotask_get_billing_item',
    description: 'Get a specific billing item by its Autotask integer ID. Use autotask_search_billing_items to find billing item IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        billingItemId: {
          type: 'number',
          description: 'The integer ID of the billing item to retrieve. Required.'
        }
      },
      required: ['billingItemId']
    }
  },

  // Billing Item Approval Levels tools
  {
    name: 'autotask_search_billing_item_approval_levels',
    description: 'Search for billing item approval level records in Autotask. These records describe multi-level approval history for time entries in tenants that use tiered approval workflows. Filter by time entry ID, approver resource ID, approval level number, or approval date range.',
    inputSchema: {
      type: 'object',
      properties: {
        timeEntryId: {
          type: 'number',
          description: 'Filter by time entry integer ID.'
        },
        approvalResourceId: {
          type: 'number',
          description: 'Filter by the integer ID of the approving resource.'
        },
        approvalLevel: {
          type: 'number',
          description: 'Filter by approval level number (1, 2, 3, etc.).'
        },
        approvedAfter: {
          type: 'string',
          description: 'Return records approved on or after this date. ISO format: YYYY-MM-DD.'
        },
        approvedBefore: {
          type: 'string',
          description: 'Return records approved on or before this date. ISO format: YYYY-MM-DD.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  },

  // Time Entries search tool
  {
    name: 'autotask_search_time_entries',
    description: 'Search for time entries in Autotask. Filter by resource, ticket, project, or task integer IDs, date range, approval status, or billable flag. approvalStatus "unapproved" returns entries where billingApprovalDateTime is null (not yet posted); "approved" returns posted entries; omit or use "all" for no filter. billable: true returns billable entries only, false returns non-billable only. Returns 25 results per page by default.',
    inputSchema: {
      type: 'object',
      properties: {
        resourceId: {
          type: 'number',
          description: 'Filter by the integer ID of the resource (user) who logged the time.'
        },
        ticketId: {
          type: 'number',
          description: 'Filter by ticket integer ID.'
        },
        projectId: {
          type: 'number',
          description: 'Filter by project integer ID.'
        },
        taskId: {
          type: 'number',
          description: 'Filter by task integer ID.'
        },
        approvalStatus: {
          type: 'string',
          enum: ['unapproved', 'approved', 'all'],
          description: '"unapproved" = not yet posted (billingApprovalDateTime is null). "approved" = already posted. "all" or omit = no filter.'
        },
        billable: {
          type: 'boolean',
          description: 'Filter by billable status. true = billable entries only. false = non-billable entries only. Omit to return both.'
        },
        dateWorkedAfter: {
          type: 'string',
          description: 'Return entries worked on or after this date. ISO format: YYYY-MM-DD.'
        },
        dateWorkedBefore: {
          type: 'string',
          description: 'Return entries worked on or before this date. ISO format: YYYY-MM-DD.'
        },
        page: {
          type: 'number',
          description: 'Page number for pagination (default: 1)',
          minimum: 1
        },
        pageSize: {
          type: 'number',
          description: 'Results per page (default: 25, max: 500)',
          minimum: 1,
          maximum: 500
        }
      },
      required: []
    }
  }
];
