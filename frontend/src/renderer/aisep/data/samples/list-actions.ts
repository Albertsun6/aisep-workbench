// Example B of coordination/workbench-readonly-contract-20261127.md §2.2: model_list_actions run on aisep main (not via
// the workbench profile, which does not list the tool yet). Kept as TypeScript, not JSON, so the type checker holds it
// to ListActionsResult (a JSON import widens `valid` to boolean and could only be cast).
import type { ListActionsResult } from "../client";

export const LIST_ACTIONS_SAMPLE: ListActionsResult = {
	"catalogVersion": "0.2.0",
	"operations": [
		"model_add_element",
		"model_add_relationship",
		"model_remove",
		"model_set_attributes",
		"model_set_labels"
	],
	"actions": [
		{
			"id": "register-acceptance-criterion",
			"iri": "https://aisep.example/ont/aisep#ActionRegisterAcceptanceCriterion",
			"title": "登记验收标准并挂到需求",
			"description": "新增一个 aisep:AcceptanceCriterion 元素，并用一条 am4:Aggregation（源 = 父需求，目标 = 验收标准）把它挂到指定需求。等价于依次调用 model_add_element 与 model_add_relationship，但两步在一次写入里全有或全无。",
			"version": "1.0.0",
			"valid": true,
			"params": {
				"type": "object",
				"properties": {
					"altLabel": {
						"type": "string",
						"description": "英文名称；没给 slug 时用它生成 IRI"
					},
					"definition": {
						"type": "string",
						"description": "中文定义"
					},
					"file": {
						"type": "string",
						"description": "验收标准落在哪个文件；缺省按 model_add_element 的规则"
					},
					"gherkin": {
						"type": "string",
						"description": "Given / When / Then 文本，写入 aisep:gherkin"
					},
					"prefLabel": {
						"type": "string",
						"description": "验收标准的中文名称"
					},
					"relationshipFile": {
						"type": "string",
						"description": "聚合关系落在哪个文件；缺省按 model_add_relationship 的规则"
					},
					"requirement": {
						"type": "string",
						"description": "父需求的完整 IRI（https://aisep.example/model/<slug>/<名>）"
					},
					"slug": {
						"type": "string",
						"description": "IRI 的本地名，^[A-Za-z][A-Za-z0-9]*$"
					}
				},
				"required": [
					"prefLabel",
					"requirement"
				],
				"additionalProperties": false
			},
			"iriParams": [
				"requirement"
			],
			"destructive": false,
			"requiresPlanDigest": false,
			"guards": [
				{
					"id": "parent-is-not-a-criterion",
					"hint": "requirement 指向的是另一条验收标准。验收标准应挂在它所属的需求上，请把 requirement 换成那条需求的 IRI。"
				},
				{
					"id": "parent-is-not-deprecated",
					"hint": "requirement 指向的需求已退役（owl:deprecated true）。请挂到替代它的需求上（见它的 dcterms:isReplacedBy）。"
				}
			],
			"steps": [
				{
					"id": "criterion",
					"op": "model_add_element"
				},
				{
					"id": "aggregation",
					"op": "model_add_relationship"
				}
			],
			"definitionDigest": "sha256:1c35bb552acc916448882f8df8dc669a8ba3d0cbcda62fad6a6391ec7f9e8b0d"
		},
		{
			"id": "remove-element",
			"iri": "https://aisep.example/ont/aisep#ActionRemoveElement",
			"title": "删除元素",
			"description": "删除一个元素、关系或视图，连带以它为端点的关系并摘除成员关系（同 model_remove 的 cascade）。破坏性动作：必须先 dryRun 看计划与影响摘要，再带 planDigest 执行。",
			"version": "1.0.0",
			"valid": true,
			"params": {
				"type": "object",
				"properties": {
					"iri": {
						"type": "string",
						"description": "要删除的资源的完整 IRI"
					}
				},
				"required": [
					"iri"
				],
				"additionalProperties": false
			},
			"iriParams": [
				"iri"
			],
			"destructive": true,
			"requiresPlanDigest": true,
			"guards": [],
			"steps": [
				{
					"id": "remove",
					"op": "model_remove"
				}
			],
			"definitionDigest": "sha256:bfaa7c61f1b2e442ac1c75fd817f77089e039523f40e0d0c8dc53c72d02768f8"
		}
	]
};
