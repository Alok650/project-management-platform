import Joi from 'joi';

/** Schema for POST /auth/register */
export const registerSchema = Joi.object({
  email:       Joi.string().email().required(),
  displayName: Joi.string().min(2).max(100).required(),
  password:    Joi.string().min(8).required(),
});

/** Schema for POST /auth/login */
export const loginSchema = Joi.object({
  email:    Joi.string().email().required(),
  password: Joi.string().required(),
});
