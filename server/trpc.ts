import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

// Owner openId는 장기 실행 서버의 process.env에서 직접 읽는다.
// ENV 객체는 모듈 평가 시점에 고정되므로, 테스트에서
// process.env.OWNER_OPEN_ID를 동적으로 변경하더라도 동작하도록
// 매 요청마다 다시 읽어온다.
function readOwnerOpenId(): string {
  return process.env.OWNER_OPEN_ID ?? "";
}

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

export const adminProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user || ctx.user.role !== 'admin') {
      throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/**
 * Owner-only access guard. The single Manus openId in ENV.ownerOpenId is the
 * only account allowed to touch any trading procedure. Any other authenticated
 * user receives FORBIDDEN — used to keep the public `*.manus.space` deploy
 * usable by the owner while denying everyone else.
 *
 * Behaviour matrix:
 *  - ENV.ownerOpenId empty      → FORBIDDEN (fail-closed; deploy is
 *    misconfigured, never accidentally allow everyone)
 *  - ctx.user missing           → UNAUTHORIZED (sign-in required)
 *  - ctx.user.openId mismatched → FORBIDDEN
 *  - match                      → pass
 */
export const ownerOnlyProcedure = t.procedure.use(
  t.middleware(async opts => {
    const { ctx, next } = opts;

    if (!ctx.user) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
    }
    const ownerOpenId = readOwnerOpenId();
    if (!ownerOpenId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "소유자 openId가 설정되지 않아 접근이 제한됩니다.",
      });
    }
    if (ctx.user.openId !== ownerOpenId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "이 앱은 소유자 계정으로만 사용할 수 있습니다.",
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  }),
);

/** Pure helper: returns true when the given openId matches the configured owner. */
export function isOwnerOpenId(openId: string | null | undefined): boolean {
  const ownerOpenId = readOwnerOpenId();
  return !!ownerOpenId && !!openId && openId === ownerOpenId;
}
