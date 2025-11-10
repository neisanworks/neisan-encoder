import { expect, test } from "bun:test";
import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { BTree } from "@tylerbu/sorted-btree-es6";
import { Encoder } from "./encoder.js";

const encoder = new Encoder();
type RecordKey = Record<"id" | "lsn", number>;

@encoder.encodable({
	encoded: (tree: IndexBTree) => {
		return [tree.maxNodeSize, Array.from(tree.entries())];
	},
	reviver: (encoded) => {
		const maxNodeSize = encoded.at(0);
		assert(maxNodeSize !== undefined && typeof maxNodeSize === "number");
		const entries = encoded.at(1);
		assert(entries !== undefined && Array.isArray(entries));
		return new IndexBTree(entries, maxNodeSize);
	},
})
class IndexBTree extends BTree<RecordKey, number> {
	constructor(entries?: Array<[RecordKey, number]>, maxNodeSize = 10) {
		super(
			entries,
			(a, b) => {
				if (a.id === b.id) return a.lsn - b.lsn;
				return a.id - b.id;
			},
			maxNodeSize,
		);
	}
}

test("B+ Tree Encoding and Decoding", () => {
	const tree = new IndexBTree();

	expect(tree).toHaveProperty("__ns_parsable_name__");
	assert("__ns_parsable_name__" in tree);
	expect(tree.__ns_parsable_name__).toBeString();
	assert(typeof tree.__ns_parsable_name__ === "string");

	for (let i = 0; i < 100; i++) {
		tree.set({ id: i % 5, lsn: i }, i);
	}

	expect(tree.size).toBe(100);

	const ids = tree.filter(({ id }) => id % 5 === 0);
	expect(ids.size).toBe(20);

	const encoded = encoder.encode(tree);
	expect(encoded).toBeInstanceOf(Buffer);
	let decoded = encoder.decode<IndexBTree>(encoded);
	expect(decoded.size).toBe(tree.size);

	const pathname = path.join(process.cwd(), "user-index.nsdb");
	fs.writeFileSync(pathname, encoded);

	const data = fs.readFileSync(pathname);
	expect(data).toBeInstanceOf(Buffer);
	decoded = encoder.decode<IndexBTree>(data);
	expect(decoded.size).toBe(tree.size);
});

test("Array Encoding and Decoding", () => {
	const array = [1, "two", null, undefined, 5];
	let encoded = encoder.encode(array);
	expect(encoded).toBeInstanceOf(Buffer);
	let decoded = encoder.decode<Array<any>>(encoded);
	expect(decoded).toEqual(array);

	decoded.push(6);
	expect(decoded.length).toBe(6);
	expect(decoded[5]).toBe(6);

	encoded = encoder.encode(decoded);
	expect(encoded).toBeInstanceOf(Buffer);
	decoded = encoder.decode<Array<any>>(encoded);
	expect(decoded).toEqual([...array, 6]);
});

test("Set Encoding and Decoding", () => {
	const set = new Set([1, "two", null, undefined, 5]);
	let encoded = encoder.encode(set);
	expect(encoded).toBeInstanceOf(Buffer);
	let decoded = encoder.decode<Set<any>>(encoded);
	expect(decoded.size).toBe(set.size);

	decoded.add(6);
	expect(decoded.size).toBe(6);
	expect(decoded.has(6)).toBe(true);

	encoded = encoder.encode(decoded);
	expect(encoded).toBeInstanceOf(Buffer);
	decoded = encoder.decode<Set<any>>(encoded);
	expect(decoded).toEqual(new Set([...set, 6]));
});

test("Map Encoding and Decoding", () => {
	const map = new Map<any, any>();
	type AnyEntries = Array<[any, any]>;

	const numbers = [
		[1, 1],
		[2, 2],
		[3, 3],
	];
	numbers.forEach(([k, v]) => {
		map.set(k, v);
	});
	expect(Array.from(map.entries())).toEqual(numbers as AnyEntries);
	let encoded = encoder.encode(map);
	expect(encoded).toBeInstanceOf(Buffer);
	let decoded = encoder.decode(encoded);
	expect(decoded).toEqual(map);

	map.clear();

	const strings = [
		["one", "one"],
		["two", "two"],
		["three", "three"],
	];
	strings.forEach(([k, v]) => {
		map.set(k, v);
	});
	expect(Array.from(map.entries())).toEqual(strings as AnyEntries);
	encoded = encoder.encode(map);
	expect(encoded).toBeInstanceOf(Buffer);
	decoded = encoder.decode(encoded);
	expect(decoded).toEqual(map);

	map.clear();

	const numStringMix = [
		[1, "one"],
		["two", 2],
		[3, "three"],
	];
	numStringMix.forEach(([k, v]) => {
		map.set(k, v);
	});
	expect(Array.from(map.entries())).toEqual(numStringMix as AnyEntries);
	encoded = encoder.encode(map);
	expect(encoded).toBeInstanceOf(Buffer);
	decoded = encoder.decode(encoded);
	expect(decoded).toEqual(map);

	map.clear();

	const allMix = [
		[1, "one"],
		["two", undefined],
		[3, null],
		["four", { 1: "one", two: 2, "Three-3": "three" }],
		[{ 1: "one", two: 2, "Three-3": "three" }, "five"],
	];
	allMix.forEach(([k, v]) => {
		map.set(k, v);
	});
	expect(Array.from(map.entries())).toEqual(allMix as AnyEntries);
	encoded = encoder.encode(map);
	expect(encoded).toBeInstanceOf(Buffer);
	decoded = encoder.decode(encoded);
	expect(decoded).toEqual(map);
});

test("Class Encoding and Decoding", () => {
	interface UserData {
		email: string;
		password: string;
		attempts?: number;
	}

	@encoder.encodable()
	class User {
		email: string;
		password: string;
		attempts: number = 0;

		constructor(data: UserData) {
			this.email = data.email;
			this.password = data.password;
			this.attempts = data.attempts ?? 0;
		}

		get locked(): boolean {
			return this.attempts >= 3;
		}
	}

	const user = new User({ email: "test@example.com", password: "password123" });

	const encoded = encoder.encode(user);
	expect(encoded).toBeInstanceOf(Buffer);

	let decoded = encoder.decode<User>(encoded);
	expect(decoded).toBeInstanceOf(User);

	expect(decoded.email).toBe(user.email);
	expect(decoded.password).toBe(user.password);
	expect(decoded.attempts).toBe(user.attempts);
	expect(decoded.locked).toBe(user.locked);

	const filepath = path.join(process.cwd(), "user.nsdb");
	fs.writeFileSync(filepath, encoded, { encoding: "utf-8" });

	const data = fs.readFileSync(filepath);
	expect(data).toBeInstanceOf(Buffer);
	decoded = encoder.decode<User>(data);
	expect(decoded).toBeInstanceOf(User);
});
