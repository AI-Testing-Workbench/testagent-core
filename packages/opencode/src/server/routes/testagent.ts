// testagent_change - new file
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import * as Log from "@opencode-ai/core/util/log"
import { lazy } from "../../util/lazy"

const log = Log.create({ service: "server" })

export const TestagentRoutes = lazy(() =>
  new Hono().put(
    "/user",
    describeRoute({
      summary: "Set testagent user info",
      description: "Set the current testagent user information and optionally save authentication token.",
      operationId: "testagent.user.set",
      responses: {
        200: {
          description: "User info set successfully",
          content: {
            "application/json": {
              schema: resolver(z.boolean()),
            },
          },
        },
      },
    }),
    validator(
      "json",
      z.object({
        id: z.string().optional(),
        name: z.string().optional(),
        token: z.string().optional(),
      }),
    ),
    async (c) => {
      const { User } = await import("@/testagent/user")
      const { ExternalAuth } = await import("@/external-auth")

      const { id, name, token } = c.req.valid("json")

      log.info("Setting testagent user info", { id, name, hasToken: !!token })
      User.set({ id, name })

      if (token && id && name && !(await ExternalAuth.getToken())) {
        log.info("Saving testagent token to local file")
        await ExternalAuth.saveToken({ userId: id, userName: name, token })
      }

      return c.json(true)
    },
  ),
)
