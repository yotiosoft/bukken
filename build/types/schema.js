import { z } from "zod";
export const ScrapeListingSchemaShape = {
    url: z.string().url().optional(),
    site: z.enum(["suumo", "homes"]).optional(),
    id: z.string().min(1).optional(),
};
export const ScrapeListingSchema = z
    .object(ScrapeListingSchemaShape)
    .refine((value) => Boolean(value.url) || Boolean(value.site && value.id), {
    message: "url または site と id の両方を指定してください。",
});
