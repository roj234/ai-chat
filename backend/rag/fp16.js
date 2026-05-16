// Prompt: 用JavaScript编写一个float32 转 float16 (以整数形式返回)，以及相反转换的函数，做好rounding，写测试

/**
 * 将 32 位浮点数的位模式转换为 float16 的位模式（16 位整数）。
 * @param {number} f32Bits - 32 位无符号整数，表示 float32 的位模式。
 * @returns {number} - 16 位无符号整数，表示 float16 的位模式。
 */
export function float32ToFloat16Bits(f32Bits) {
	const sign     = (f32Bits >>> 31) & 1;
	const exp32    = (f32Bits >>> 23) & 0xFF;
	const mant32   = f32Bits & 0x7FFFFF;

	// NaN / Infinity
	if (exp32 === 0xFF) {
		if (mant32 === 0) {
			// Infinity
			return (sign << 15) | 0x7C00;
		} else {
			// NaN：保留部分尾数作为 NaN payload，确保尾数非零
			let nanMant = mant32 >> 13;
			if (nanMant === 0) nanMant = 1; // 保证 NaN 标识
			return (sign << 15) | 0x7C00 | nanMant;
		}
	}

	// 零 / 非规格化数（float32 subnormal 全部远小于 half 最小正值，直接归零）
	if (exp32 === 0) {
		// 特殊情况：如果尾数非零但极小，舍入后可能变为 0
		return (sign << 15) | 0;
	}

	// 规格化数
	const exp = exp32 - 127;               // 真实指数
	const mantWithLeading = (1 << 23) | mant32; // 加上隐含的 1，共 24 位

	// 溢出到 Infinity（half 最大指数为 15，即 exp > 15）
	if (exp > 15) {
		return (sign << 15) | 0x7C00;
	}

	// 下溢到非规格化数 / 零（half 最小规格化指数为 -14）
	if (exp < -14) {
		// 需要将 (1.mantissa) × 2^exp 表示为 half 非规格化数：0.尾数 × 2^{-14}
		// 即 mantWithLeading 右移 (-14 - exp) 位后再转为 half 尾数
		// 等价于 mantWithLeading × 2^{exp+1} = hal_mant × 2^{-24}
		const rshift = -(exp + 1); // 总右移位数
		const shifted = mantWithLeading >> rshift;
		const remainder = mantWithLeading & ((1 << rshift) - 1);
		let halfMant = shifted;
		let roundUp = false;

		if (rshift <= 24) {
			const halfWay = 1 << (rshift - 1);
			if (remainder > halfWay) {
				roundUp = true;
			} else if (remainder === halfWay) {
				// tie to even
				if (halfMant & 1) roundUp = true;
			}
		}
		if (roundUp) halfMant++;
		// 舍入可能导致非规格化数溢出为最小规格化数（指数 1，尾数 0）
		if (halfMant >= 0x400) {
			return (sign << 15) | (1 << 10);
		}
		return (sign << 15) | halfMant;
	}

	// 规格化数：-14 <= exp <= 15
	const halfExp = exp + 15;
	const shiftedMant = mant32 >> 13;         // 取高 10 位
	const remainder = mant32 & 0x1FFF;        // 低 13 位
	let halfMant = shiftedMant;
	let roundUp = false;

	if (remainder > 0x1000) {
		roundUp = true;
	} else if (remainder === 0x1000) {
		// tie to even
		if (halfMant & 1) roundUp = true;
	}

	if (roundUp) {
		halfMant++;
		if (halfMant >= 0x400) {               // 尾数溢出，进位到指数
			halfMant = 0;
			const newExp = halfExp + 1;
			if (newExp >= 31) {                  // 指数溢出 → Infinity
				return (sign << 15) | 0x7C00;
			}
			return (sign << 15) | (newExp << 10);
		}
	}
	return (sign << 15) | (halfExp << 10) | halfMant;
}

/**
 * 将 float16 的位模式（16 位整数）转换为 float32 的位模式（32 位整数）。
 * @param {number} f16Bits - 16 位无符号整数，表示 float16 的位模式。
 * @returns {number} - 32 位无符号整数，表示 float32 的位模式。
 */
export function float16ToFloat32Bits(f16Bits) {
	const sign   = (f16Bits >>> 15) & 1;
	const exp5   = (f16Bits >>> 10) & 0x1F;
	const mant10 = f16Bits & 0x3FF;

	// NaN / Infinity
	if (exp5 === 31) {
		const mant23 = mant10 << 13;
		if (mant10 === 0) {
			// Infinity
			return (sign << 31) | 0x7F800000;
		} else {
			// NaN：保留 payload
			return (sign << 31) | 0x7F800000 | mant23;
		}
	}

	// 零 / 非规格化数
	if (exp5 === 0) {
		if (mant10 === 0) {
			return sign << 31; // ±0
		}
		// 非规格化数：将尾数左移到规格化形式（加上隐含 1）
		let mant = mant10;
		let exp = -14;
		while (mant < 0x400) {
			mant <<= 1;
			exp--;
		}
		mant &= 0x3FF;                      // 去掉隐含 1，保留 10 位有效位
		const exp32 = exp + 127;
		return (sign << 31) | (exp32 << 23) | (mant << 13);
	}

	// 规格化数
	const exp = exp5 - 15;
	const exp32 = exp + 127;
	const mant23 = mant10 << 13;
	return (sign << 31) | (exp32 << 23) | mant23;
}