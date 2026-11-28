import { describe, expect, it } from "vitest";
import { isSparqlIri } from "./view-element";

describe("isSparqlIri", () => {
	it("accepts an absolute IRI and rejects what the SPARQL IRIREF production excludes", () => {
		expect(isSparqlIri("https://example.org/m#quoteApp")).toBe(true);
		for (const bad of ["quoteApp", "https://e.org/a b", "https://e.org/a>", "https://e.org/a\u0001", "https://e.org/a\u001f"]) {
			expect(isSparqlIri(bad), JSON.stringify(bad)).toBe(false);
		}
	});
});
