import Joi from 'joi';

/** Schema for creating a workflow status */
export const createStatusSchema = Joi.object({
  name:     Joi.string().min(1).max(100).required(),
  category: Joi.string().valid('TODO', 'IN_PROGRESS', 'DONE').required(),
  position: Joi.number().integer().min(0).optional(),
  wipLimit: Joi.number().integer().min(1).allow(null).optional(),
});

/** Schema for updating a workflow status */
export const updateStatusSchema = Joi.object({
  name:     Joi.string().min(1).max(100).optional(),
  position: Joi.number().integer().min(0).optional(),
  wipLimit: Joi.number().integer().min(1).allow(null).optional(),
});

/** Schema for creating a workflow transition rule */
export const createTransitionSchema = Joi.object({
  fromStatusId: Joi.string().uuid().required(),
  toStatusId:   Joi.string().uuid().required(),
  name:         Joi.string().max(100).optional(),
});

/** Schema for triggering a status transition on an issue */
export const transitionIssueSchema = Joi.object({
  toStatusId: Joi.string().uuid().required(),
});
