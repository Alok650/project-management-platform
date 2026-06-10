import Joi from 'joi';

export const createSprintSchema = Joi.object({
  name:      Joi.string().min(1).max(200).required(),
  goal:      Joi.string().max(2000).optional(),
  startDate: Joi.string().isoDate().optional(),
  endDate:   Joi.string().isoDate().optional(),
});

export const updateSprintSchema = Joi.object({
  name:      Joi.string().min(1).max(200).optional(),
  goal:      Joi.string().max(2000).optional(),
  startDate: Joi.string().isoDate().optional(),
  endDate:   Joi.string().isoDate().optional(),
});

export const completeSprintSchema = Joi.object({
  carryOverIssueIds: Joi.array().items(Joi.string().uuid()).default([]),
  nextSprintId:      Joi.string().uuid().optional(),
});
