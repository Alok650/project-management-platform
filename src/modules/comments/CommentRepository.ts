import { AppDataSource } from '../../config/database';
import { Comment } from '../../models/Comment';
import type { CursorPage } from '../../core/types/Pagination';
import { encodeCursor, decodeCursor } from '../../core/types/Pagination';

/** Data access layer for Comment entities */
export class CommentRepository {
  private readonly repo = AppDataSource.getRepository(Comment);

  /**
   * Find a comment by UUID.
   * @param id - Comment UUID
   */
  findById(id: string): Promise<Comment | null> {
    return this.repo.findOne({ where: { id }, relations: ['author'] });
  }

  /**
   * Cursor-paginated top-level comments for an issue (parent IS NULL).
   * Children (replies) are loaded for each page item in a separate query.
   * @param issueId - Issue UUID
   * @param cursor - Opaque pagination cursor
   * @param limit - Maximum number of items to return
   */
  async listByIssue(issueId: string, cursor?: string, limit = 25): Promise<CursorPage<Comment>> {
    const qb = this.repo.createQueryBuilder('c')
      .leftJoinAndSelect('c.author', 'author')
      .where('c.issueId = :issueId AND c.parentId IS NULL AND c.deletedAt IS NULL', { issueId })
      .orderBy('c.createdAt', 'ASC')
      .addOrderBy('c.id', 'ASC')
      .limit(limit + 1);

    if (cursor) {
      const decoded = decodeCursor(cursor);
      const sep = decoded.lastIndexOf('__');
      const cursorDate = decoded.slice(0, sep);
      const cursorId   = decoded.slice(sep + 2);
      qb.andWhere(
        '(c.createdAt > :cursorDate OR (c.createdAt = :cursorDate AND c.id > :cursorId))',
        { cursorDate, cursorId },
      );
    }

    const rows = await qb.getMany();
    const hasMore = rows.length > limit;
    const items   = hasMore ? rows.slice(0, -1) : rows;
    const last    = items.at(-1);
    const nextCursor = hasMore && last
      ? encodeCursor(`${last.createdAt.toISOString()}__${last.id}`)
      : null;
    return { items, nextCursor, hasMore };
  }

  /**
   * List direct replies to a comment.
   * @param parentId - Parent comment UUID
   */
  listReplies(parentId: string): Promise<Comment[]> {
    return this.repo.find({
      where: { parentId, deletedAt: null as any },
      relations: ['author'],
      order: { createdAt: 'ASC' },
    });
  }

  /**
   * Persist a comment (create or update).
   * @param data - Partial comment fields to save
   */
  save(data: Partial<Comment>): Promise<Comment> {
    return this.repo.save(data);
  }

  /**
   * Soft-delete a comment.
   * @param id - Comment UUID
   */
  softDelete(id: string): Promise<void> {
    return this.repo.softDelete(id).then(() => undefined);
  }
}
