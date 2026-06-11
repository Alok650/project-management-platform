import Joi from 'joi';

export const createDefinitionSchema = Joi.object({
  name:     Joi.string().min(1).max(100).required(),
  type:     Joi.string().valid('TEXT', 'NUMBER', 'DROPDOWN', 'DATE').required(),
  options:  Joi.array().items(Joi.string().max(200)).min(1).optional(),
  required: Joi.boolean().default(false),
  position: Joi.number().integer().min(0).default(0),
});

export const updateDefinitionSchema = Joi.object({
  name:     Joi.string().min(1).max(100).optional(),
  options:  Joi.array().items(Joi.string().max(200)).min(1).optional(),
  required: Joi.boolean().optional(),
  position: Joi.number().integer().min(0).optional(),
});

export const setValueSchema = Joi.object({
  value: Joi.string().max(5000).required(),
});
