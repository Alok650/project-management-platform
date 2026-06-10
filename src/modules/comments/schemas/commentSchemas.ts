import Joi from 'joi';

export const createCommentSchema = Joi.object({
  content:  Joi.string().min(1).max(50000).required(),
  parentId: Joi.string().uuid().optional(),
});

export const updateCommentSchema = Joi.object({
  content: Joi.string().min(1).max(50000).required(),
});
