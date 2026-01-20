import React, { useState, useEffect, useRef } from "react";
import "./ChatWindow.css";
import { getAIMessage } from "../api/api";
import { marked } from "marked";
import PartCard from "./PartCard";

const API_URL = 'http://localhost:3001';

function ChatWindow() {

  const defaultMessage = [{
    role: "assistant",
    content: "Hi, how can I help you today?"
  }];

  const [messages,setMessages] = useState(defaultMessage)
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [showInactivityMessage, setShowInactivityMessage] = useState(false);

  const messagesEndRef = useRef(null);

  const scrollToBottom = () => {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
      scrollToBottom();
  }, [messages, isLoading, showInactivityMessage]);

  // Listen for browser inactivity events via SSE
  useEffect(() => {
    const eventSource = new EventSource(`${API_URL}/api/events`);

    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.reason === 'inactivity') {
        setShowInactivityMessage(true);
      }
    };

    eventSource.onerror = () => {
      // Silently handle connection errors (server might not be running)
      eventSource.close();
    };

    return () => {
      eventSource.close();
    };
  }, []);

  const handleSend = async (input) => {
    if (input.trim() !== "" && !isLoading) {
      // Clear inactivity message when user sends a new message
      setShowInactivityMessage(false);

      const userMessage = { role: "user", content: input };
      const updatedMessages = [...messages, userMessage];

      // Set user message
      setMessages(updatedMessages);
      setInput("");
      setIsLoading(true);

      // Call API with message history (skip the initial greeting)
      const historyForAPI = updatedMessages.slice(1);
      const newMessage = await getAIMessage(historyForAPI);
      setMessages(prevMessages => [...prevMessages, newMessage]);
      setIsLoading(false);
    }
  };

  return (
      <div className="messages-container">
          {messages.map((message, index) => (
              <div key={index} className={`${message.role}-message-container`}>
                  {message.content && (
                      <div className={`message ${message.role}-message`}>
                          <div dangerouslySetInnerHTML={{__html: marked(message.content).replace(/<p>|<\/p>/g, "")}}></div>
                          {message.parts && message.parts.length > 0 && (
                              <div className="part-cards">
                                  {message.parts.map((part, partIndex) => (
                                      <PartCard key={partIndex} part={part} />
                                  ))}
                              </div>
                          )}
                      </div>
                  )}
              </div>
          ))}
          {isLoading && (
              <div className="assistant-message-container">
                  <div className="message assistant-message typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                  </div>
              </div>
          )}
          {showInactivityMessage && (
              <div className="inactivity-message">
                  The agent has left the chat due to inactivity. Submit a message at any time to resume the conversation.
              </div>
          )}
          <div ref={messagesEndRef} />
          <div className="input-area">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Type a message..."
              onKeyPress={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  handleSend(input);
                  e.preventDefault();
                }
              }}
              rows="3"
            />
            <button className="send-button" onClick={() => handleSend(input)} disabled={isLoading}>
              {isLoading ? "Sending..." : "Send"}
            </button>
          </div>
      </div>
);
}

export default ChatWindow;
