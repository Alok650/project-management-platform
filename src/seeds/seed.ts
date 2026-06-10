import 'dotenv/config';
import 'reflect-metadata';
import * as bcrypt from 'bcryptjs';
import { AppDataSource } from '../config/database';
import { User } from '../models/User';
import { Project } from '../models/Project';
import { ProjectMember } from '../models/ProjectMember';
import { WorkflowStatus } from '../models/WorkflowStatus';
import { WorkflowTransition } from '../models/WorkflowTransition';
import { Sprint } from '../models/Sprint';
import { Issue } from '../models/Issue';
import {
  ProjectRole,
  StatusCategory,
  SprintStatus,
  IssueType,
  IssuePriority,
} from '../core/types/enums';

/** Seed users created by the script */
const SEED_USERS = [
  { email: 'admin@demo.com',  displayName: 'Admin User',  password: 'password123' },
  { email: 'dev@demo.com',    displayName: 'Dev User',    password: 'password123' },
  { email: 'tester@demo.com', displayName: 'Tester User', password: 'password123' },
] as const;

/** Name of the demo project used throughout the script */
const PROJECT_KEY = 'DEMO';

/** Bcrypt cost factor for password hashing */
const BCRYPT_ROUNDS = 10;

/**
 * Idempotent database seed.
 *
 * Inserts three users, one project, project members, workflow statuses,
 * transitions, one sprint, and ten demo issues.  Each step is guarded by
 * a lookup so the script can be re-run safely without creating duplicates.
 *
 * @returns Promise that resolves when all seed data has been committed.
 */
async function seed(): Promise<void> {
  await AppDataSource.initialize();

  try {
    const userRepo       = AppDataSource.getRepository(User);
    const projectRepo    = AppDataSource.getRepository(Project);
    const memberRepo     = AppDataSource.getRepository(ProjectMember);
    const statusRepo     = AppDataSource.getRepository(WorkflowStatus);
    const transitionRepo = AppDataSource.getRepository(WorkflowTransition);
    const sprintRepo     = AppDataSource.getRepository(Sprint);
    const issueRepo      = AppDataSource.getRepository(Issue);

    // ------------------------------------------------------------------ //
    // 1. Users                                                             //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting users…');
    const [adminSeed, devSeed, testerSeed] = SEED_USERS;

    async function upsertUser(
      seed: { email: string; displayName: string; password: string },
    ): Promise<User> {
      const existing = await userRepo.findOne({ where: { email: seed.email } });
      if (existing) {
        console.log(`  skip  ${seed.email} (already exists)`);
        return existing;
      }
      const user = userRepo.create({
        email: seed.email,
        displayName: seed.displayName,
        passwordHash: await bcrypt.hash(seed.password, BCRYPT_ROUNDS),
      });
      await userRepo.save(user);
      console.log(`  added ${seed.email}`);
      return user;
    }

    const adminUser  = await upsertUser(adminSeed);
    const devUser    = await upsertUser(devSeed);
    const testerUser = await upsertUser(testerSeed);

    // ------------------------------------------------------------------ //
    // 2. Project                                                           //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting project…');
    let project = await projectRepo.findOne({ where: { key: PROJECT_KEY } });
    if (!project) {
      project = projectRepo.create({
        name: 'Demo Project',
        key: PROJECT_KEY,
        description: 'Automatically seeded demo project.',
        createdById: adminUser.id,
      });
      await projectRepo.save(project);
      console.log(`  added project ${PROJECT_KEY}`);
    } else {
      console.log(`  skip  project ${PROJECT_KEY} (already exists)`);
    }

    // ------------------------------------------------------------------ //
    // 3. Project members                                                   //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting project members…');

    async function upsertMember(userId: string, role: ProjectRole): Promise<void> {
      const existing = await memberRepo.findOne({
        where: { projectId: project!.id, userId },
      });
      if (existing) {
        console.log(`  skip  member ${userId} (already exists)`);
        return;
      }
      const member = memberRepo.create({ projectId: project!.id, userId, role });
      await memberRepo.save(member);
      console.log(`  added member ${userId} as ${role}`);
    }

    await upsertMember(adminUser.id,  ProjectRole.PROJECT_LEAD);
    await upsertMember(devUser.id,    ProjectRole.MEMBER);
    await upsertMember(testerUser.id, ProjectRole.MEMBER);

    // ------------------------------------------------------------------ //
    // 4. Workflow statuses                                                 //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting workflow statuses…');

    const statusDefs = [
      { name: 'TODO',        category: StatusCategory.TODO,        position: 0 },
      { name: 'IN_PROGRESS', category: StatusCategory.IN_PROGRESS, position: 1 },
      { name: 'IN_REVIEW',   category: StatusCategory.IN_PROGRESS, position: 2 },
      { name: 'DONE',        category: StatusCategory.DONE,        position: 3 },
    ] as const;

    const statusMap: Record<string, WorkflowStatus> = {};

    for (const def of statusDefs) {
      let status = await statusRepo.findOne({
        where: { projectId: project.id, name: def.name },
      });
      if (!status) {
        status = statusRepo.create({
          projectId: project.id,
          name: def.name,
          category: def.category,
          position: def.position,
          wipLimit: null,
        });
        await statusRepo.save(status);
        console.log(`  added status "${def.name}"`);
      } else {
        console.log(`  skip  status "${def.name}" (already exists)`);
      }
      statusMap[def.name] = status;
    }

    // ------------------------------------------------------------------ //
    // 5. Workflow transitions                                              //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting workflow transitions…');

    const transitionDefs = [
      { from: 'TODO',        to: 'IN_PROGRESS', name: 'Start Progress'  },
      { from: 'IN_PROGRESS', to: 'IN_REVIEW',   name: 'Send to Review'  },
      { from: 'IN_REVIEW',   to: 'DONE',        name: 'Approve'         },
      { from: 'IN_REVIEW',   to: 'IN_PROGRESS', name: 'Request Changes' },
    ] as const;

    for (const def of transitionDefs) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const fromStatus = statusMap[def.from]!;
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      const toStatus   = statusMap[def.to]!;
      const existing   = await transitionRepo.findOne({
        where: {
          projectId:    project.id,
          fromStatusId: fromStatus.id,
          toStatusId:   toStatus.id,
        },
      });
      if (existing) {
        console.log(`  skip  transition "${def.name}" (already exists)`);
        continue;
      }
      const transition = transitionRepo.create({
        projectId:    project.id,
        fromStatusId: fromStatus.id,
        toStatusId:   toStatus.id,
        name:         def.name,
      });
      await transitionRepo.save(transition);
      console.log(`  added transition "${def.name}"`);
    }

    // ------------------------------------------------------------------ //
    // 6. Sprint                                                            //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting sprint…');
    let sprint = await sprintRepo.findOne({
      where: { projectId: project.id, name: 'Sprint 1' },
    });
    if (!sprint) {
      sprint = sprintRepo.create({
        projectId: project.id,
        name:      'Sprint 1',
        goal:      'Deliver the first slice of demo functionality.',
        status:    SprintStatus.ACTIVE,
        startDate: '2026-06-02',
        endDate:   '2026-06-13',
        velocity:  null,
      });
      await sprintRepo.save(sprint);
      console.log('  added Sprint 1');
    } else {
      console.log('  skip  Sprint 1 (already exists)');
    }

    // ------------------------------------------------------------------ //
    // 7. Issues                                                            //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting issues…');

    const issueDefs: Array<{
      issueKey: string;
      type: IssueType;
      title: string;
      statusName: 'TODO' | 'IN_PROGRESS' | 'IN_REVIEW' | 'DONE';
      priority: IssuePriority;
      assigneeId: string | null;
      sprintId: string | null;
      storyPoints: number | null;
    }> = [
      // 3 STORYs in TODO
      {
        issueKey: 'DEMO-1', type: IssueType.STORY,
        title: 'User authentication story',
        statusName: 'TODO', priority: IssuePriority.HIGH,
        assigneeId: null, sprintId: null, storyPoints: null,
      },
      {
        issueKey: 'DEMO-2', type: IssueType.STORY,
        title: 'Dashboard overview story',
        statusName: 'TODO', priority: IssuePriority.MEDIUM,
        assigneeId: null, sprintId: null, storyPoints: null,
      },
      {
        issueKey: 'DEMO-3', type: IssueType.STORY,
        title: 'Notification preferences story',
        statusName: 'TODO', priority: IssuePriority.LOW,
        assigneeId: null, sprintId: null, storyPoints: null,
      },
      // 3 TASKs in IN_PROGRESS (assigned to developer, in Sprint 1)
      {
        issueKey: 'DEMO-4', type: IssueType.TASK,
        title: 'Implement login endpoint',
        statusName: 'IN_PROGRESS', priority: IssuePriority.HIGH,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: null,
      },
      {
        issueKey: 'DEMO-5', type: IssueType.TASK,
        title: 'Build project member API',
        statusName: 'IN_PROGRESS', priority: IssuePriority.MEDIUM,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: null,
      },
      {
        issueKey: 'DEMO-6', type: IssueType.TASK,
        title: 'Add sprint planning page',
        statusName: 'IN_PROGRESS', priority: IssuePriority.MEDIUM,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: null,
      },
      // 2 BUGs in IN_REVIEW
      {
        issueKey: 'DEMO-7', type: IssueType.BUG,
        title: 'Fix pagination off-by-one error',
        statusName: 'IN_REVIEW', priority: IssuePriority.HIGH,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: null,
      },
      {
        issueKey: 'DEMO-8', type: IssueType.BUG,
        title: 'Resolve CORS preflight failure on /api/auth',
        statusName: 'IN_REVIEW', priority: IssuePriority.HIGHEST,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: null,
      },
      // 2 TASKs in DONE (with story points)
      {
        issueKey: 'DEMO-9', type: IssueType.TASK,
        title: 'Set up CI pipeline',
        statusName: 'DONE', priority: IssuePriority.MEDIUM,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: 3,
      },
      {
        issueKey: 'DEMO-10', type: IssueType.TASK,
        title: 'Configure database migrations workflow',
        statusName: 'DONE', priority: IssuePriority.MEDIUM,
        assigneeId: devUser.id, sprintId: sprint.id, storyPoints: 5,
      },
    ];

    for (const def of issueDefs) {
      const existing = await issueRepo.findOne({ where: { issueKey: def.issueKey } });
      if (existing) {
        console.log(`  skip  issue ${def.issueKey} (already exists)`);
        continue;
      }
      const issue = issueRepo.create({
        issueKey:    def.issueKey,
        projectId:   project.id,
        type:        def.type,
        title:       def.title,
        description: null,
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        statusId:    statusMap[def.statusName]!.id,
        priority:    def.priority,
        assigneeId:  def.assigneeId,
        reporterId:  adminUser.id,
        parentId:    null,
        sprintId:    def.sprintId,
        storyPoints: def.storyPoints,
        labels:      [],
      });
      await issueRepo.save(issue);
      console.log(`  added issue ${def.issueKey}: ${def.title}`);
    }

    // ------------------------------------------------------------------ //
    // 8. Issue-key counter                                                 //
    // ------------------------------------------------------------------ //
    console.log('[seed] Upserting issue_key_counters…');
    await AppDataSource.query(
      `INSERT INTO issue_key_counters (project_id, counter)
       VALUES (?, 10)
       ON DUPLICATE KEY UPDATE counter = GREATEST(counter, 10)`,
      [project.id],
    );
    console.log('  set counter = 10 for project', PROJECT_KEY);

    // ------------------------------------------------------------------ //
    // Summary                                                              //
    // ------------------------------------------------------------------ //
    console.log('\n======================================');
    console.log('Seed complete.');
    console.log(`  Admin email   : ${adminSeed.email}`);
    console.log(`  Password      : ${adminSeed.password}`);
    console.log('\nTo generate a JWT for this user, POST to /api/auth/login with:');
    console.log(JSON.stringify({ email: adminSeed.email, password: adminSeed.password }, null, 2));
    console.log('======================================\n');
  } finally {
    await AppDataSource.destroy();
  }
}

seed().catch((err: unknown) => {
  console.error('[seed] Fatal error:', err);
  process.exit(1);
});
