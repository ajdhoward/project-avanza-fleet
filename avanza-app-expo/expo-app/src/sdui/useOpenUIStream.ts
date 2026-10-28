import { useCallback, useEffect, useRef, useState } from "react";
import { sduiManifestUrl } from "@/lib/api";

interface StreamState {
	program: string | null;
	streaming: boolean;
	error: string | null;
	updatedAt: number;
}

export function useOpenUIStream(pollMs = 60000): StreamState & { reload: () => void } {
	const [state, setState] = useState<StreamState>({
		program: null,
		streaming: false,
		error: null,
		updatedAt: 0,
	});
	const abortRef = useRef<AbortController | null>(null);
	const mountedRef = useRef(true);

	const load = useCallback(async () => {
		abortRef.current?.abort();
		const controller = new AbortController();
		abortRef.current = controller;
		if (mountedRef.current) setState((s) => ({ ...s, streaming: true, error: null }));
		let buffer = "";
		try {
			const res = await fetch(sduiManifestUrl(true), { signal: controller.signal });
			if (!res.ok || !res.body) throw new Error(`manifest http ${res.status}`);
			const reader = res.body.getReader();
			const decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				if (mountedRef.current)
					setState((s) => ({ ...s, program: buffer, streaming: true, updatedAt: Date.now() }));
			}
			buffer += decoder.decode();
			if (mountedRef.current)
				setState({ program: buffer, streaming: false, error: null, updatedAt: Date.now() });
		} catch (err) {
			if (mountedRef.current)
				setState((s) => ({
					...s,
					streaming: false,
					error: (err as Error).name === "AbortError" ? null : String((err as Error).message ?? err),
				}));
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		load();
		const t = setInterval(load, pollMs);
		return () => {
			mountedRef.current = false;
			clearInterval(t);
			abortRef.current?.abort();
		};
	}, [load, pollMs]);

	return { ...state, reload: load };
}
