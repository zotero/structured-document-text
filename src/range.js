export function makeContentPoint(ref, offset = undefined) {
	if (!Array.isArray(ref)) {
		throw new TypeError('Content point ref must be an array');
	}
	let point = [...ref];
	if (Number.isInteger(offset)) {
		point.push(offset);
	}
	return point;
}

export function makeContentRange(startRef, endRef, startOffset = undefined, endOffset = undefined) {
	return [
		makeContentPoint(startRef, startOffset),
		makeContentPoint(endRef, endOffset),
	];
}

export function setContentRangeStart(range, ref, offset = undefined) {
	range[0] = makeContentPoint(ref, offset);
}

export function setContentRangeEnd(range, ref, offset = undefined) {
	range[1] = makeContentPoint(ref, offset);
}

export function splitContentPoint(point, content) {
	if (!Array.isArray(content)) {
		throw new TypeError('splitContentPoint requires content');
	}
	if (!point) {
		return { ref: null, offset: undefined };
	}
	if (!Array.isArray(point)) {
		return { ref: null, offset: undefined };
	}

	let ref = [];
	let node = null;
	for (let i = 0; i < point.length; i++) {
		let value = point[i];
		if (!Number.isInteger(value)) {
			return { ref: null, offset: undefined };
		}
		if (isTextNode(node) && i === point.length - 1) {
			return { ref, offset: value };
		}
		ref.push(value);
		node = ref.length === 1
			? content[value]
			: Array.isArray(node?.content)
				? node.content[value]
				: null;
	}
	return { ref, offset: undefined };
}

export function splitContentRange(range, content) {
	return {
		start: splitContentPoint(range?.[0], content),
		end: splitContentPoint(range?.[1], content),
	};
}

function isTextNode(node) {
	return !!node && typeof node === 'object' && typeof node.text === 'string';
}
