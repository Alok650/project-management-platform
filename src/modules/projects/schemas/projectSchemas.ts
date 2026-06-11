import Joi from 'joi';

export const createProjectSchema = Joi.object({
  name:        Joi.string().min(2).max(200).required(),
  key:         Joi.string().pattern(/^[A-Z0-9]{2,10}$/).required(),
  description: Joi.string().max(2000).optional(),
});

export const updateProjectSchema = Joi.object({
  name:        Joi.string().min(2).max(200).optional(),
  description: Joi.string().max(2000).optional(),
});

export const addMemberSchema = Joi.object({
  userId: Joi.string().uuid().required(),
  role:   Joi.string().valid('ADMIN','PROJECT_LEAD','MEMBER','VIEWER').required(),
});
