import assert from "node:assert";

export class Encoder {
	private types = new Map([
		["boolean", 0],
		["string", 1],
		["number", 2],
		["bigint", 3],
		["null", 4],
		["undefined", 5],
		["array", 6],
		["map", 7],
		["set", 8],
		["regex", 9],
		["object", 10],
	]);
	private lastID: number = this.types.size;
	private customEncoderHelpers = new Map<number, (item: any) => Array<any>>();
	private customDecoders = new Map<number, (encoded: Buffer) => unknown>();

	encodable =
		<
			V extends Array<any>,
			T extends new (
				...args: Array<any>
			) => K,
			K = object,
		>(methods?: {
			encoded: (item: K) => V;
			reviver: (encoded: V) => K;
		}) =>
		(target: T): T => {
			const name = `$$${target.name}`;
			assert(!this.types.has(name));
			Object.defineProperty(target.prototype, "__ns_parsable_name__", {
				enumerable: false,
				writable: false,
				configurable: false,
				value: name,
			});

			const id = this.lastID;
			this.types.set(name, id);
			if (methods) {
				this.customEncoderHelpers.set(id, methods.encoded);
			}
			this.customDecoders.set(id, (encoded: Buffer): K => {
				let offset = 0;
				const count = encoded.readUInt32LE(offset);
				offset += 4;

				if (methods) {
					const items: Array<any> = [];
					for (let i = 0; i < count; i++) {
						const length = encoded.readUInt16LE(offset);
						offset += 2;
						items.push(this.decode(encoded.subarray(offset, offset + length)));
						offset += length;
					}

					const instance = methods.reviver(items as V);
					assert(typeof instance === "object" && instance !== null);
					return instance;
				}

				const results: Array<[PropertyKey, unknown]> = [];
				for (let i = 0; i < count; i++) {
					const length = encoded.readUInt16LE(offset);
					offset += 2;
					results.push(
						this.decode(encoded.subarray(offset, offset + length)) as [
							PropertyKey,
							unknown,
						],
					);
					offset += length;
				}
				const decoded = Object.fromEntries(results);
				assert(typeof decoded === "object" && decoded !== null);

				return Object.defineProperty(
					Object.assign(Object.create(target.prototype), decoded),
					"__ns_parsable_name__",
					{
						enumerable: false,
						writable: false,
						configurable: false,
						value: name,
					},
				);
			});
			this.lastID++;

			return target;
		};

	encode(item: unknown): Buffer {
		const encoder = (item: unknown): Buffer => {
			if (item === null || item === undefined) {
				const tag = this.types.get(item === null ? "null" : "undefined");
				assert(tag !== undefined);
				const buffer = Buffer.alloc(1);
				const view = new DataView(buffer.buffer);
				view.setUint8(0, tag);
				return buffer;
			}

			let offset = 0;
			if (typeof item !== "object") {
				assert(typeof item !== "function" && typeof item !== "symbol");
				const tag = this.types.get(item === null ? "null" : typeof item);
				assert(tag !== undefined);
				switch (typeof item) {
					case "boolean": {
						const buffer = Buffer.alloc(1 + 1);
						const view = new DataView(buffer.buffer);
						view.setUint8(0, tag);
						offset += 1;
						view.setUint8(offset, item ? 1 : 0);
						return buffer;
					}
					case "string": {
						const length = Buffer.byteLength(item, "utf-8");
						const buffer = Buffer.alloc(1 + 4 + length);
						const view = new DataView(buffer.buffer);
						view.setUint8(0, tag);
						offset += 1;
						view.setUint32(offset, length, true);
						offset += 4;
						buffer.write(item, offset, "utf-8");
						return buffer;
					}
					case "number": {
						const buffer = Buffer.alloc(1 + 8);
						const view = new DataView(buffer.buffer);
						view.setUint8(0, tag);
						offset += 1;
						view.setFloat64(offset, item, true);
						return buffer;
					}
					case "bigint": {
						const buffer = Buffer.alloc(1 + 8);
						const view = new DataView(buffer.buffer);
						view.setUint8(0, tag);
						offset += 1;
						view.setBigInt64(offset, item, true);
						return buffer;
					}
					default:
						return Buffer.alloc(0);
				}
			}

			if (item instanceof RegExp) {
				const tag = this.types.get("regex");
				assert(tag !== undefined, "Regex type not found");
				const parts = encoder([item.source, item.flags]);
				const buffer = Buffer.alloc(1 + 4 + parts.length);
				const view = new DataView(buffer.buffer);
				view.setUint8(0, tag);
				offset += 1;
				view.setUint32(offset, parts.length, true);
				offset += 4;
				parts.copy(buffer, offset);
				return buffer;
			}

			const arrayLikeBuffer = (tag: number, array: Array<any>): Buffer => {
				const count = array.length;
				const buffers: Array<Buffer<ArrayBufferLike>> = array.map(encoder);
				const length = buffers.reduce((acc, buffer) => acc + buffer.byteLength, 0);
				const buffer = Buffer.alloc(1 + 4 + count * 2 + length);
				const view = new DataView(buffer.buffer);
				view.setUint8(0, tag);
				offset += 1;
				view.setUint32(offset, count, true);
				offset += 4;
				for (const part of buffers) {
					view.setUint16(offset, part.byteLength, true);
					offset += 2;
					part.copy(buffer, offset);
					offset += part.byteLength;
				}
				return buffer;
			};

			if (Array.isArray(item)) {
				const tag = this.types.get("array");
				assert(tag !== undefined, "Array not registered");
				return arrayLikeBuffer(tag, item);
			} else if (item instanceof Map) {
				const tag = this.types.get("map");
				assert(tag !== undefined, "Map not registered");
				return arrayLikeBuffer(tag, Array.from(item.entries()));
			} else if (item instanceof Set) {
				const tag = this.types.get("set");
				assert(tag !== undefined, "Set not registered");
				return arrayLikeBuffer(tag, Array.from(item.values()));
			} else if (
				"__ns_parsable_name__" in item &&
				typeof item.__ns_parsable_name__ === "string" &&
				this.types.has(item.__ns_parsable_name__)
			) {
				const tag = this.types.get(item.__ns_parsable_name__);
				assert(tag !== undefined, `${item.__ns_parsable_name__} not registered`);
				if (this.customEncoderHelpers.has(tag)) {
					const helper = this.customEncoderHelpers.get(tag);
					assert(
						helper !== undefined,
						`Helper for ${item.__ns_parsable_name__} not registered`,
					);
					assert(
						typeof helper === "function",
						`Helper for ${item.__ns_parsable_name__} is not a function`,
					);
					return arrayLikeBuffer(tag, helper(item));
				}

				return arrayLikeBuffer(tag, Object.entries(item));
			} else {
				const tag = this.types.get("object");
				assert(tag !== undefined, "Object not registered");
				return arrayLikeBuffer(tag, Object.entries(item));
			}
		};

		return encoder(item);
	}

	decode<T = unknown>(encoded: Buffer): T {
		const decoder = (item: Buffer): unknown => {
			const tag = item.readUint8(0);
			let offset = 1;

			switch (tag) {
				case 0: {
					// Boolean
					return item.readUint8(offset) === 1;
				}
				case 1: {
					// String
					const length = item.readUint32LE(offset);
					offset += 4;
					return item.toString("utf-8", offset, offset + length);
				}
				case 2: {
					// Number
					return item.readDoubleLE(offset);
				}
				case 3: {
					// BigInt
					return item.readBigInt64LE(offset);
				}
				case 4: {
					// Null
					return null;
				}
				case 5: {
					// Undefined
					return undefined;
				}
				case 6: {
					// Array
					const count = item.readUInt32LE(offset);
					offset += 4;
					const result: Array<unknown> = [];
					for (let i = 0; i < count; i++) {
						const length = item.readUInt16LE(offset);
						offset += 2;
						result.push(decoder(item.subarray(offset, offset + length)));
						offset += length;
					}
					return result;
				}
				case 7: {
					// Map
					const count = item.readUInt32LE(offset);
					offset += 4;
					const map = new Map();
					for (let i = 0; i < count; i++) {
						const length = item.readUInt16LE(offset);
						offset += 2;
						const entry = decoder(item.subarray(offset, offset + length));
						offset += length;
						assert(Array.isArray(entry) && entry.length === 2);
						map.set(entry[0], entry[1]);
					}
					return map;
				}
				case 8: {
					// Set
					const count = item.readUInt32LE(offset);
					offset += 4;
					const set = new Set();
					for (let i = 0; i < count; i++) {
						const length = item.readUInt16LE(offset);
						offset += 2;
						set.add(decoder(item.subarray(offset, offset + length)));
						offset += length;
					}
					return set;
				}
				case 9: {
					// RegExp
					const length = item.readUInt32LE(offset);
					offset += 4;
					const parts = decoder(item.subarray(offset, offset + length));
					assert(Array.isArray(parts) && parts.length === 2);
					return new RegExp(parts[0], parts[1]);
				}
				case 10: {
					// Object
					const count = item.readUInt32LE(offset);
					offset += 4;
					const result: Array<[PropertyKey, unknown]> = [];
					for (let i = 0; i < count; i++) {
						const length = item.readUInt16LE(offset);
						offset += 2;
						result.push(
							decoder(item.subarray(offset, offset + length)) as [PropertyKey, unknown],
						);
						offset += length;
					}
					return Object.fromEntries(result);
				}
				default: {
					if (!this.customDecoders.has(tag)) return undefined;

					const customDecoder = this.customDecoders.get(tag);
					assert(customDecoder !== undefined);

					return customDecoder(item.subarray(offset));
				}
			}
		};

		return decoder(encoded) as T;
	}
}
