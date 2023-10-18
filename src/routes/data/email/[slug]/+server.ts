import { AUTH_SECRET } from '$env/static/private';
import { find, objectMapper } from '$lib/data/database';
import { decode, getToken } from '@auth/core/jwt';
import { error } from '@sveltejs/kit';
import { captureException, startTransaction } from '@sentry/node';

function isUUID(s: string) {
	return new RegExp(
		'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
	).test(s);
}

/** @type {import('./$types').RequestHandler} */
export async function GET({ params, url }) {
	const whereCriteria: Criteria = {};

	if (isUUID(params.slug)) {
		whereCriteria.rowid = { equals: params.slug };
	} else {
		whereCriteria.shortid = { equals: params.slug };
	}

	const options = { where: whereCriteria };
	const email = await find('email', options);
	return new Response(JSON.stringify(email[0]));
}

/** @type {import('./$types').RequestHandler} */
export async function POST({ params, request, cookies, url }) {
	// HTTPS-only should be enforced on host, this is a developer convenience
	const authCookieName =
		url.protocol === 'https:' ? '__Secure-next-auth.session-token' : 'next-auth.session-token';
	const jwt = await decode({
		token: cookies.get(authCookieName),
		secret: process.env.AUTH_SECRET || AUTH_SECRET
	});

	if (!jwt) {
		return new Response('Invalid token', { status: 401 });
	}
	if (
		jwt.email !== request.headers.get('sender-email') &&
		jwt.email !== request.headers.get('user-email')
	) {
		return new Response('Email address mismatch', { status: 403 });
	}

	const whereCriteria: Criteria = {};
	whereCriteria.shortid = params.slug;
	try {
		if (request.headers.get('increment-send') === 'true' && request.headers.get('sender-email')) {
			const senderEmail = request.headers.get('sender-email') as string;

			const emailOptions: Clause = { where: whereCriteria };
			const userOptions: Clause = {
				where: { email: senderEmail }
			};

			const sentEmailList = await objectMapper.user.findMany({
				where: { email: senderEmail, sent_email_list: { has: params.slug } }
			});

			if (sentEmailList.length <= 0) {
				emailOptions.data = {
					send_count: { increment: 1 }
				};
				userOptions.data = { sent_email_list: { push: params.slug } }; // push shortid
				// TODO merge into single query once cockroachdb supports record types https://github.com/cockroachdb/cockroach/issues/70099?version=v23.1
				await objectMapper.$transaction([
					objectMapper.email.update({ ...emailOptions }),
					objectMapper.user.update({ ...userOptions })
				]);
				return new Response('incremented');
			}
		} else if (
			request.headers.get('remove-email-content') === 'true' &&
			request.headers.get('user-email')
		) {
			const userEmail = request.headers.get('user-email') as string;
			const userOptions: Clause = {
				where: { email: userEmail }
			};
			userOptions.data = { ignored_email_list: { push: params.slug } }; // push shortid

			await objectMapper.user.update({ ...userOptions });
		} else if (
			request.headers.get('report-email-content') === 'true' &&
			request.headers.get('user-email') &&
			request.body
		) {
			const userEmail = request.headers.get('user-email') as string;
			const issueOptions: Clause = {
				where: { added_by_email_id: { added_by: userEmail, email_id: params.slug } }
			};
			const formData = await request.json();

			let upsertable;
			for (const [key, value] of Object.entries(formData)) {
				if (key === 'reportType' && value) {
					upsertable = {
						type: value
					};
				} else if (key === 'customReport' && value) {
					upsertable = {
						email_id: params.slug,
						added_by: userEmail,
						description: value
					};
				}
			}
			issueOptions.create = {
				user: {
					connect: { email: userEmail }
				},
				email: {
					connect: { shortid: params.slug }
				},
				...upsertable
			};
			issueOptions.update = upsertable;
			await objectMapper.issue.upsert({ ...issueOptions });
		}
	} catch (e) {
		const errorTransaction = startTransaction({ op: 'error', name: 'email' });
		captureException(e);
		console.error(e);
		errorTransaction.finish();
	}
	return new Response('ok');
}
