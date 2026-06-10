/** Issue type hierarchy: Epic > Story/Task/Bug > Subtask */
export enum IssueType {
  EPIC    = 'EPIC',
  STORY   = 'STORY',
  TASK    = 'TASK',
  BUG     = 'BUG',
  SUBTASK = 'SUBTASK',
}

/** Five-level priority scale; MEDIUM is the default on new issues */
export enum IssuePriority {
  HIGHEST = 'HIGHEST',
  HIGH    = 'HIGH',
  MEDIUM  = 'MEDIUM',
  LOW     = 'LOW',
  LOWEST  = 'LOWEST',
}

/** Lifecycle state of a sprint: plan → active → completed */
export enum SprintStatus {
  PLANNING  = 'PLANNING',
  ACTIVE    = 'ACTIVE',
  COMPLETED = 'COMPLETED',
}

/** A member's permission level within a project; controls what they can read/write */
export enum ProjectRole {
  ADMIN        = 'ADMIN',
  PROJECT_LEAD = 'PROJECT_LEAD',
  MEMBER       = 'MEMBER',
  VIEWER       = 'VIEWER',
}

/** Broad semantic category that maps workflow statuses to board swim-lanes */
export enum StatusCategory {
  TODO        = 'TODO',
  IN_PROGRESS = 'IN_PROGRESS',
  DONE        = 'DONE',
}

/** Type of automatic action executed when a workflow transition fires */
export enum AutoActionType {
  ASSIGN_REVIEWER = 'ASSIGN_REVIEWER',
  SET_FIELD       = 'SET_FIELD',
  NOTIFY          = 'NOTIFY',
}

/** The type of mutation recorded in an ActivityLog entry */
export enum ActivityAction {
  CREATED        = 'CREATED',
  UPDATED        = 'UPDATED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  ASSIGNED       = 'ASSIGNED',
  UNASSIGNED     = 'UNASSIGNED',
  SPRINT_ADDED   = 'SPRINT_ADDED',
  SPRINT_REMOVED = 'SPRINT_REMOVED',
  COMMENT_ADDED  = 'COMMENT_ADDED',
  COMMENT_UPDATED = 'COMMENT_UPDATED',
  COMMENT_DELETED = 'COMMENT_DELETED',
}

/** Data type of a project-defined custom field */
export enum CustomFieldType {
  TEXT     = 'TEXT',
  NUMBER   = 'NUMBER',
  DROPDOWN = 'DROPDOWN',
  DATE     = 'DATE',
}

/** Category of in-app notification; abbreviated to avoid collision with DOM Notification */
export enum NotifType {
  ASSIGNED       = 'ASSIGNED',
  MENTIONED      = 'MENTIONED',
  STATUS_CHANGED = 'STATUS_CHANGED',
  WATCHER        = 'WATCHER',
}
