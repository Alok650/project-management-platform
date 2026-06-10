/** Flattened issue shape used in the board view — avoids loading full relations */
export interface BoardIssue {
  readonly id: string;
  readonly issueKey: string;
  readonly type: string;
  readonly title: string;
  readonly priority: string;
  readonly storyPoints: number | null;
  readonly assignee: { readonly id: string; readonly displayName: string } | null;
  readonly parentId: string | null;
  readonly labels: string[];
  readonly version: number;
}

/** A single board column (status lane) */
export interface BoardColumn {
  readonly statusId: string;
  readonly statusName: string;
  readonly category: string;
  readonly position: number;
  readonly wipLimit: number | null;
  readonly issues: BoardIssue[];
}

/** Complete board state for a project/sprint combination */
export interface BoardView {
  readonly projectId: string;
  readonly sprintId: string | null;
  readonly columns: BoardColumn[];
  readonly cachedAt: string;
}
