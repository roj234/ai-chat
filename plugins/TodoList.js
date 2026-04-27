
const todo = {
	name: 'todo_write',
	description: 'Creates and manages a structured task list for your current session. This helps track progress, organize complex tasks, and demonstrate thoroughness.',
	parametersJsonSchema: {
		type: 'object',
		properties: {
			todos: {
				type: 'array',
				items: {
					type: 'object',
					properties: {
						content: {
							type: 'string',
							minLength: 1,
						},
						status: {
							type: 'string',
							enum: ['pending', 'in_progress', 'completed'],
						},
						id: {
							type: 'string',
						},
					},
					required: ['content', 'status', 'id'],
					additionalProperties: false,
				},
				description: 'The updated todo list',
			},
		},
		required: ['todos'],
		$schema: 'http://json-schema.org/draft-07/schema#',
	},
};