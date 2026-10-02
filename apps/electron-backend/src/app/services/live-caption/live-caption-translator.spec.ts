import {
    LiveCaptionTranslator,
    normalizeLiveCaptionTranslationBaseUrl,
} from './live-caption-translator';

describe('LiveCaptionTranslator', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('sends an OpenAI-compatible chat completion request', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: '美联储维持利率不变。',
                        },
                    },
                ],
            }),
        });
        globalThis.fetch = fetchMock as typeof fetch;

        const translator = new LiveCaptionTranslator({
            enabled: true,
            provider: 'openai-compatible',
            baseUrl: 'https://example.test/v1/',
            apiKey: 'secret-key',
            model: 'translation-model',
            targetLanguage: 'Simplified Chinese',
        });

        const result = await translator.translate(
            'The Federal Reserve kept rates unchanged.'
        );

        expect(result.text).toBe('美联储维持利率不变。');
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0][0]).toBe(
            'https://example.test/v1/chat/completions'
        );
        const request = fetchMock.mock.calls[0][1] as {
            headers?: unknown;
            body?: unknown;
        };
        expect(request.headers).toEqual({
            Authorization: 'Bearer secret-key',
            'Content-Type': 'application/json',
        });
        expect(JSON.parse(String(request.body))).toMatchObject({
            model: 'translation-model',
            messages: [
                { role: 'system' },
                {
                    role: 'user',
                    content: 'The Federal Reserve kept rates unchanged.',
                },
            ],
        });
    });

    it('accepts array-style message content used by compatible providers', async () => {
        globalThis.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [
                    {
                        message: {
                            content: [
                                { type: 'text', text: '市场' },
                                { type: 'text', text: '上涨。' },
                            ],
                        },
                    },
                ],
            }),
        }) as typeof fetch;

        const translator = new LiveCaptionTranslator({
            apiKey: 'secret-key',
            model: 'translation-model',
        });

        await expect(translator.translate('Markets rose.')).resolves.toMatchObject(
            { text: '市场上涨。' }
        );
    });

    it('rejects incomplete translation configuration before network use', () => {
        expect(
            () =>
                new LiveCaptionTranslator({
                    enabled: true,
                    apiKey: '',
                    model: 'translation-model',
                })
        ).toThrow('Translation API key is required.');
        expect(
            () =>
                new LiveCaptionTranslator({
                    enabled: true,
                    apiKey: 'secret-key',
                    model: '',
                })
        ).toThrow('Translation model is required.');
    });

    it('requires TLS for remote translation endpoints', () => {
        expect(() =>
            normalizeLiveCaptionTranslationBaseUrl('http://example.test/v1')
        ).toThrow('must use HTTPS');
        expect(
            normalizeLiveCaptionTranslationBaseUrl('http://localhost:11434/v1/')
        ).toBe('http://localhost:11434/v1');
        expect(
            normalizeLiveCaptionTranslationBaseUrl('https://example.test/v1/')
        ).toBe('https://example.test/v1');
    });

    it('rejects credentials embedded in the endpoint URL', () => {
        expect(() =>
            normalizeLiveCaptionTranslationBaseUrl(
                'https://user:password@example.test/v1'
            )
        ).toThrow('must not contain credentials');
    });

    it('does not allow an internal backlog', async () => {
        let resolveFetch: ((value: unknown) => void) | undefined;
        globalThis.fetch = jest.fn().mockImplementation(
            () =>
                new Promise((resolve) => {
                    resolveFetch = resolve;
                })
        ) as typeof fetch;
        const translator = new LiveCaptionTranslator({
            apiKey: 'secret-key',
            model: 'translation-model',
        });

        const first = translator.translate('First sentence.');
        await expect(translator.translate('Second sentence.')).rejects.toThrow(
            'Translation request already in progress.'
        );

        resolveFetch?.({
            ok: true,
            status: 200,
            json: async () => ({
                choices: [{ message: { content: '第一句。' } }],
            }),
        });
        await expect(first).resolves.toMatchObject({ text: '第一句。' });
    });
});
