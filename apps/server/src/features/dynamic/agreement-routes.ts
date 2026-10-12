import {
  type AgreementState,
  createAgreementService,
  type HabitSaveInput,
  type HabitVariantInput,
  type RuleNoteInput,
  type RuleSaveInput,
  type Store,
} from "@valerie/core";
import type { Context, Hono } from "hono";
import { readJsonObject, routeHandler } from "../../http";
import { dynamicErrorResponse } from "./routes";

const body = (c: Context) =>
  readJsonObject(c, {
    contentType: "Send agreement edits as JSON.",
    shape: "Provide an agreement edit object.",
  });

export function mountAgreementRoutes(app: Hono, store: Store) {
  const agreements = createAgreementService(store),
    owner = { actor: "owner" as const };
  const handle = routeHandler(dynamicErrorResponse);
  app.get(
    "/api/agreements",
    handle((c) =>
      c.json(
        agreements.overview({
          dayId: c.req.query("dayId"),
          period: c.req.query("period") as "day" | "week" | "month" | undefined,
        }),
      ),
    ),
  );
  app.put(
    "/api/agreements/settings",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        settings: agreements.saveSettings({
          expectedVersion: input.expectedVersion as number,
          allowValerieManageHabits: input.allowValerieManageHabits as boolean,
          allowValerieManageRules: input.allowValerieManageRules as boolean,
        }),
      });
    }),
  );
  for (const target of ["habit", "rule"] as const) {
    const plural = target === "habit" ? "habits" : "rules";
    app.get(
      `/api/agreements/${plural}/:id`,
      handle((c) => {
        const revision = c.req.query("revision");
        const options = revision === undefined ? {} : { revision: Number(revision) };
        const definition =
          target === "habit"
            ? agreements.readHabit(c.req.param("id") ?? "", options)
            : agreements.readRule(c.req.param("id") ?? "", options);
        return definition
          ? c.json({ [target]: definition })
          : c.json({ error: "Agreement not found." }, 404);
      }),
    );
    const save = handle(async (c) => {
      const input = await body(c),
        id = c.req.param("id");
      const common = {
        ...(id ? { id, expectedVersion: input.expectedVersion as number } : {}),
        ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
      };
      if (target === "habit")
        return c.json({
          habit: agreements.saveHabit(
            {
              ...common,
              name: input.name as string,
              reason: input.reason as string,
              behaviorId: input.behaviorId as string,
              fullPractice: input.fullPractice as string,
              smallerPractice: input.smallerPractice as string | null,
              cadence: input.cadence as HabitSaveInput["cadence"],
              slots: input.slots as HabitSaveInput["slots"],
              effectiveAt: input.effectiveAt as string,
              threshold: input.threshold as number | null,
            },
            owner,
          ),
        });
      return c.json({
        rule: agreements.saveRule(
          {
            ...common,
            name: input.name as string,
            meaning: input.meaning as string,
            reason: input.reason as string,
            scope: input.scope as string,
            effectiveAt: input.effectiveAt as string,
            expiresAt: input.expiresAt as string | null,
            timezone: input.timezone as string,
            window: input.window as RuleSaveInput["window"],
            exceptions: input.exceptions as string[],
            condition: input.condition as RuleSaveInput["condition"],
          },
          owner,
        ),
      });
    });
    app.post(`/api/agreements/${plural}`, save);
    app.put(`/api/agreements/${plural}/:id`, save);
    app.post(
      `/api/agreements/${plural}/:id/state`,
      handle(async (c) => {
        const input = await body(c);
        return c.json({
          [target]: agreements.setState(
            {
              target,
              id: c.req.param("id") ?? "",
              expectedVersion: input.expectedVersion as number,
              state: input.state as AgreementState,
              ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
            },
            owner,
          ),
        });
      }),
    );
  }
  app.get(
    "/api/agreements/opportunities",
    handle((c) => c.json({ opportunities: agreements.opportunities(c.req.query("dayId") ?? "") })),
  );
  app.get(
    "/api/agreements/metrics",
    handle((c) =>
      c.json(
        agreements.metrics({
          period: c.req.query("period") as "day" | "week" | "month" | undefined,
          habitId: c.req.query("habitId"),
          dayLimit: Number(c.req.query("dayLimit") ?? 90),
        }),
      ),
    ),
  );
  app.get(
    "/api/agreements/variants/:id",
    handle((c) => {
      const variant = agreements.readVariant(c.req.param("id") ?? "");
      return variant ? c.json({ variant }) : c.json({ error: "Practice variant not found." }, 404);
    }),
  );
  app.post(
    "/api/agreements/variants",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        variant: agreements.logVariant(
          {
            habitId: input.habitId as string,
            wakingDayId: input.wakingDayId as string,
            definitionVersion: input.definitionVersion as number,
            eventId: input.eventId as string,
            expectedEventVersion: input.expectedEventVersion as number,
            variant: input.variant as HabitVariantInput["variant"],
            ...(input.id === undefined
              ? {}
              : { id: input.id as string, expectedVersion: input.expectedVersion as number }),
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
  app.post(
    "/api/agreements/variants/:id/void",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        variant: agreements.voidVariant(
          {
            id: c.req.param("id") ?? "",
            expectedVersion: input.expectedVersion as number,
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
  app.get(
    "/api/agreements/rules/:id/notes",
    handle((c) =>
      c.json({
        notes: agreements.ruleNotes(c.req.param("id") ?? "", {
          limit: Number(c.req.query("limit") ?? 20),
        }),
      }),
    ),
  );
  app.post(
    "/api/agreements/rules/:id/notes",
    handle(async (c) => {
      const input = await body(c);
      return c.json({
        note: agreements.logRuleNote(
          {
            ruleId: c.req.param("id") ?? "",
            ruleVersion: input.ruleVersion as number,
            wakingDayId: input.wakingDayId as string | null,
            summary: input.summary as string,
            kind: input.kind as RuleNoteInput["kind"],
            disposition: input.disposition as RuleNoteInput["disposition"],
            occurred: input.occurred as RuleNoteInput["occurred"],
            ...(input.sourceIds === undefined ? {} : { sourceIds: input.sourceIds as string[] }),
          },
          owner,
        ),
      });
    }),
  );
}
