
import * as THREE from "../libs/three.js/build/three.module.js";
import { Points } from "./Points.js";

export class VolumeRequest {
	constructor(pointcloud, volume, callback) {
		this.pointcloud = pointcloud;
		this.volume = volume;
		this.callback = callback;
		this.maxDepth = Number.MAX_VALUE;
		this.temporaryResult = new Points();
		this.pointsServed = 0;
		this.highestLevelServed = 0;

		this.priorityQueue = new BinaryHeap(function(x) { return 1 / x.weight; });

		this._worldToBox = this.volume.matrixWorld.clone().invert();
		this._volumeWorldAABB = this._computeVolumeWorldAABB();

		this.initialize();
	}

	_computeVolumeWorldAABB() {
		let box = new THREE.Box3();
		let m = this.volume.matrixWorld;
		let corners = [
			[-0.5, -0.5, -0.5], [ 0.5, -0.5, -0.5],
			[-0.5,  0.5, -0.5], [ 0.5,  0.5, -0.5],
			[-0.5, -0.5,  0.5], [ 0.5, -0.5,  0.5],
			[-0.5,  0.5,  0.5], [ 0.5,  0.5,  0.5],
		];
		for (let [x, y, z] of corners) {
			box.expandByPoint(new THREE.Vector3(x, y, z).applyMatrix4(m));
		}
		return box;
	}

	initialize() {
		this.priorityQueue.push({ node: this.pointcloud.pcoGeometry.root, weight: Infinity });
	}

	_nodeIntersectsVolume(node) {
		let bbWorld = node.boundingBox.clone().applyMatrix4(this.pointcloud.matrixWorld);
		return bbWorld.intersectsBox(this._volumeWorldAABB);
	}

	traverse(node) {
		let stack = [];
		for (let i = 0; i < 8; i++) {
			let child = node.children[i];
			if (child && this._nodeIntersectsVolume(child)) {
				stack.push(child);
			}
		}

		while (stack.length > 0) {
			let node = stack.pop();
			this.priorityQueue.push({ node: node, weight: node.boundingSphere.radius });

			if (node.level < this.maxDepth) {
				for (let i = 0; i < 8; i++) {
					let child = node.children[i];
					if (child && this._nodeIntersectsVolume(child)) {
						stack.push(child);
					}
				}
			}
		}
	}

	update() {
		if (!this.updateGeneratorInstance) {
			this.updateGeneratorInstance = this.updateGenerator();
		}
		let result = this.updateGeneratorInstance.next();
		if (result.done) {
			this.updateGeneratorInstance = null;
		}
	}

	* updateGenerator() {
		let maxNodesPerUpdate = 1;
		let intersectedNodes = [];

		for (let i = 0; i < Math.min(maxNodesPerUpdate, this.priorityQueue.size()); i++) {
			let element = this.priorityQueue.pop();
			let node = element.node;

			if (node.level > this.maxDepth) {
				continue;
			}

			if (node.loaded) {
				intersectedNodes.push(node);
				exports.lru.touch(node);
				this.highestLevelServed = Math.max(node.getLevel(), this.highestLevelServed);

				let geom = node.pcoGeometry;
				let hierarchyStepSize = geom ? geom.hierarchyStepSize : 1;
				let doTraverse = node.getLevel() === 0 ||
					(node.level % hierarchyStepSize === 0 && node.hasChildren);

				if (doTraverse) {
					this.traverse(node);
				}
			} else {
				node.load();
				this.priorityQueue.push(element);
			}
		}

		if (intersectedNodes.length > 0) {
			for (let done of this.getPointsInsideVolume(intersectedNodes, this.temporaryResult)) {
				if (!done) {
					yield false;
				}
			}
			if (this.temporaryResult.numPoints > 100) {
				this.pointsServed += this.temporaryResult.numPoints;
				this.callback.onProgress({ request: this, points: this.temporaryResult });
				this.temporaryResult = new Points();
			}
		}

		if (this.priorityQueue.size() === 0) {
			if (this.temporaryResult.numPoints > 0) {
				this.pointsServed += this.temporaryResult.numPoints;
				this.callback.onProgress({ request: this, points: this.temporaryResult });
				this.temporaryResult = new Points();
			}

			this.callback.onFinish({ request: this });

			let index = this.pointcloud.profileRequests.indexOf(this);
			if (index >= 0) {
				this.pointcloud.profileRequests.splice(index, 1);
			}
		}

		yield true;
	}

	* getAccepted(numPoints, node, worldMatrix, testMatrix) {
		let checkpoint = performance.now();

		let accepted = new Uint32Array(numPoints);
		let acceptedPositions = new Float32Array(numPoints * 3);
		let numAccepted = 0;

		let testPos = new THREE.Vector3();
		let worldPos = new THREE.Vector3();
		let view = new Float32Array(node.geometry.attributes.position.array);

		for (let i = 0; i < numPoints; i++) {
			let x = view[i * 3 + 0];
			let y = view[i * 3 + 1];
			let z = view[i * 3 + 2];

			testPos.set(x, y, z).applyMatrix4(testMatrix);

			if (testPos.x >= -0.5 && testPos.x <= 0.5 &&
				testPos.y >= -0.5 && testPos.y <= 0.5 &&
				testPos.z >= -0.5 && testPos.z <= 0.5) {

				worldPos.set(x, y, z).applyMatrix4(worldMatrix);
				acceptedPositions[3 * numAccepted + 0] = worldPos.x;
				acceptedPositions[3 * numAccepted + 1] = worldPos.y;
				acceptedPositions[3 * numAccepted + 2] = worldPos.z;
				accepted[numAccepted] = i;
				numAccepted++;
			}

			if ((i % 1000) === 0) {
				let duration = performance.now() - checkpoint;
				if (duration > 4) {
					yield false;
					checkpoint = performance.now();
				}
			}
		}

		accepted = accepted.subarray(0, numAccepted);
		acceptedPositions = acceptedPositions.subarray(0, numAccepted * 3);

		yield [accepted, acceptedPositions];
	}

	* getPointsInsideVolume(nodes, target) {
		let checkpoint = performance.now();

		for (let node of nodes) {
			let numPoints = node.numPoints;
			let geometry = node.geometry;

			if (!numPoints) {
				continue;
			}

			let nodeMatrix = new THREE.Matrix4().makeTranslation(...node.boundingBox.min.toArray());
			let worldMatrix = new THREE.Matrix4().multiplyMatrices(this.pointcloud.matrixWorld, nodeMatrix);
			let testMatrix = new THREE.Matrix4().multiplyMatrices(this._worldToBox, worldMatrix);

			let points = new Points();

			let accepted = null;
			let acceptedPositions = null;

			for (let result of this.getAccepted(numPoints, node, worldMatrix, testMatrix)) {
				if (!result) {
					yield false;
					checkpoint = performance.now();
				} else {
					[accepted, acceptedPositions] = result;
				}
			}

			let duration = performance.now() - checkpoint;
			if (duration > 4) {
				yield false;
				checkpoint = performance.now();
			}

			if (accepted.length === 0) {
				continue;
			}

			points.data.position = acceptedPositions;

			let relevantAttributes = Object.keys(geometry.attributes)
				.filter(a => !['position', 'indices'].includes(a));

			for (let attributeName of relevantAttributes) {
				let attribute = geometry.attributes[attributeName];
				let numElements = attribute.array.length / numPoints;

				if (numElements !== parseInt(numElements)) {
					continue;
				}

				let Type = attribute.array.constructor;
				let filteredBuffer = new Type(numElements * accepted.length);
				let source = attribute.array;

				for (let i = 0; i < accepted.length; i++) {
					let index = accepted[i];
					let start = index * numElements;
					filteredBuffer.set(source.subarray(start, start + numElements), i * numElements);
				}

				points.data[attributeName] = filteredBuffer;
			}

			points.numPoints = accepted.length;
			target.add(points);
		}

		yield true;
	}

	cancel() {
		this.callback.onCancel();
		this.priorityQueue = new BinaryHeap(function(x) { return 1 / x.weight; });

		let index = this.pointcloud.profileRequests.indexOf(this);
		if (index >= 0) {
			this.pointcloud.profileRequests.splice(index, 1);
		}
	}
}
