import { CommentService } from './CommentService';
import { CommentRepository } from './CommentRepository';
import { IssueRepository } from '../issues/IssueRepository';

/** Thin orchestration layer for comment operations */
export class CommentManager {
  private readonly service: CommentService;

  constructor() {
    this.service = new CommentService(new CommentRepository(), new IssueRepository());
  }

  /**
   * Create a comment on an issue, optionally as a reply.
   * @param issueId - Issue being commented on
   * @param authorId - User creating the comment
   * @param content - Raw comment text (may contain @mentions)
   * @param parentId - Parent comment UUID for replies; undefined = top-level
   * @param correlationId - Request correlation ID
   */
  create(issueId: string, authorId: string, content: string, parentId: string | undefined, correlationId: string) {
    return this.service.create(issueId, authorId, content, parentId, correlationId);
  }

  /**
   * Update comment content. Only the original author may edit.
   * @param commentId - Comment UUID
   * @param content - New comment text
   * @param actorId - User performing the update
   */
  update(commentId: string, content: string, actorId: string) {
    return this.service.update(commentId, content, actorId);
  }

  /**
   * Soft-delete a comment. Only the original author may delete.
   * @param commentId - Comment UUID
   * @param actorId - User performing the deletion
   */
  delete(commentId: string, actorId: string) {
    return this.service.delete(commentId, actorId);
  }

  /**
   * Paginated top-level comments with replies loaded per item.
   * @param issueId - Issue UUID
   * @param cursor - Opaque pagination cursor
   * @param limit - Maximum number of top-level comments to return
   */
  list(issueId: string, cursor?: string, limit?: number) {
    return this.service.list(issueId, cursor, limit);
  }
}
