const API_URL = 'http://localhost:3001';

export const getAIMessage = async (messages) => {
  try {
    const response = await fetch(`${API_URL}/api/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      throw new Error('Failed to get response');
    }

    return await response.json();
  } catch (error) {
    console.error('API Error:', error);
    return {
      role: 'assistant',
      content: 'Sorry, I encountered an error. Please try again.',
    };
  }
};
