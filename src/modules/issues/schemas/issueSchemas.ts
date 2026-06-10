import Joi from 'joi';

/** Schema for POST /projects/:id/issues */
export const createIssueSchema = Joi.object({
  type:        Joi.string().valid('EPIC', 'STORY', 'TASK', 'BUG', 'SUBTASK').required(),
  title:       Joi.string().min(1).max(500).required(),
  description: Joi.string().max(50000).optional(),
  priority:    Joi.string().valid('HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST').default('MEDIUM'),
  assigneeId:  Joi.string().uuid().optional(),
  parentId:    Joi.string().uuid().optional(),
  sprintId:    Joi.string().uuid().optional(),
  storyPoints: Joi.number().integer().min(0).max(100).optional(),
  labels:      Joi.array().items(Joi.string().max(50)).default([]),
  statusId:    Joi.string().uuid().optional(),
});

/** Schema for PATCH /issues/:id — version required for optimistic locking */
export const updateIssueSchema = Joi.object({
  title:       Joi.string().min(1).max(500).optional(),
  description: Joi.string().max(50000).optional(),
  priority:    Joi.string().valid('HIGHEST', 'HIGH', 'MEDIUM', 'LOW', 'LOWEST').optional(),
  assigneeId:  Joi.string().uuid().allow(null).optional(),
  sprintId:    Joi.string().uuid().allow(null).optional(),
  storyPoints: Joi.number().integer().min(0).max(100).allow(null).optional(),
  labels:      Joi.array().items(Joi.string().max(50)).optional(),
  version:     Joi.number().integer().required(),
});
