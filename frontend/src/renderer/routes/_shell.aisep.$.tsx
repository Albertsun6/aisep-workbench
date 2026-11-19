import { createFileRoute } from "@tanstack/react-router";
import { AisepRoot } from "../aisep/AisepRoot";

export const Route = createFileRoute("/_shell/aisep/$")({ component: AisepRoot });
