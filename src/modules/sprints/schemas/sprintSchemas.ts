import Joi from 'joi';

const dateOnly = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/).optional();

export const createSprintSchema = Joi.object({
  name:      Joi.string().min(1).max(200).required(),
  goal:      Joi.string().max(2000).optional(),
  startDate: dateOnly,
  endDate:   dateOnly,
});

export const updateSprintSchema = Joi.object({
  name:      Joi.string().min(1).max(200).optional(),
  goal:      Joi.string().max(2000).optional(),
  startDate: dateOnly,
  endDate:   dateOnly,
});

export const completeSprintSchema = Joi.object({
  carryOverIssueIds: Joi.array().items(Joi.string().uuid()).default([]),
  nextSprintId:      Joi.string().uuid().optional(),
});
