import pLimit from 'p-limit';
import { CommentRepository } from './CommentRepository';
import { MentionParser } from './MentionParser';
import { IssueRepository } from '../issues/IssueRepository';
import { UserRepository } from '../auth/UserRepository';
import { eventBus } from '../../core/events/DomainEventBus';
import { NotFoundError, ForbiddenError } from '../../core/errors/errors';
import type { CommentAddedEvent } from '../../core/events/events';
import type { Comment } from '../../models/Comment';
import type { CursorPage } from '../../core/types/Pagination';
import { CORE_CONSTANTS } from '../../core/constants';

/** Business logic for comment creation, threading, and updates */
export class CommentService {
  private readonly userRepo = new UserRepository();

  constructor(
    private readonly repo:       CommentRepository,
    private readonly issueRepo:  IssueRepository,
  ) {}

  /**
   * Create a comment on an issue, optionally as a reply.
   * Parses @mentions and publishes CommentAddedEvent.
   *
   * @param issueId - Issue being commented on
   * @param authorId - User creating the comment
   * @param content - Raw comment text (may contain @mentions)
   * @param parentId - Parent comment UUID for replies; undefined = top-level
   * @param correlationId - Request correlation ID
   */
  async create(
    issueId: string,
    authorId: string,
    content: string,
    parentId: string | undefined,
    correlationId: string,
  ): Promise<Comment> {
    const issue = await this.issueRepo.findById(issueId);
    if (!issue) throw new NotFoundError('Issue', issueId);

    if (parentId) {
      const parent = await this.repo.findById(parentId);
      if (!parent) throw new NotFoundError('Comment', parentId);
    }

    const handles = MentionParser.extract(content);
    const mentions = await this.userRepo.resolveHandles(handles);
    const comment = await this.repo.save({ issueId, authorId, content, parentId: parentId ?? null, mentions });

    eventBus.publish({
      type: 'CommentAdded',
      occurredAt: new Date(),
      correlationId,
      payload: {
        commentId:  comment.id,
        issueId,
        projectId:  issue.projectId,
        authorId,
        mentions,
      },
    } as CommentAddedEvent);

    return comment;
  }

  /**
   * Update comment content. Only the original author may edit.
   * @param commentId - Comment UUID
   * @param content - New comment text
   * @param actorId - User performing the update
   * @throws {ForbiddenError} If actorId does not match the comment's author
   */
  async update(commentId: string, content: string, actorId: string): Promise<Comment> {
    const comment = await this.repo.findById(commentId);
    if (!comment) throw new NotFoundError('Comment', commentId);
    if (comment.authorId !== actorId) throw new ForbiddenError('edit', 'this comment');

    const mentions = MentionParser.extract(content);
    return this.repo.save({ ...comment, content, mentions });
  }

  /**
   * Soft-delete a comment. Only the original author may delete.
   * @param commentId - Comment UUID
   * @param actorId - User performing the deletion
   * @throws {ForbiddenError} If actorId does not match the comment's author
   */
  async delete(commentId: string, actorId: string): Promise<void> {
    const comment = await this.repo.findById(commentId);
    if (!comment) throw new NotFoundError('Comment', commentId);
    if (comment.authorId !== actorId) throw new ForbiddenError('delete', 'this comment');
    await this.repo.softDelete(commentId);
  }

  /**
   * Paginated top-level comments with replies loaded per item.
   * @param issueId - Issue UUID
   * @param cursor - Opaque pagination cursor
   * @param limit - Maximum number of top-level comments to return
   */
  async list(issueId: string, cursor?: string, limit?: number): Promise<CursorPage<Comment & { replies: Comment[] }>> {
    const page = await this.repo.listByIssue(issueId, cursor, limit);
    const concurrencyLimit = pLimit(CORE_CONSTANTS.CONCURRENCY_LIMIT);
    const itemsWithReplies = await Promise.all(
      page.items.map((c) => concurrencyLimit(async () => ({ ...c, replies: await this.repo.listReplies(c.id) }))),
    );
    return { ...page, items: itemsWithReplies };
  }
}
