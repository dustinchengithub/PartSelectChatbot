import React from "react";
import "./PartCard.css";

function PartCard({ part }) {
  const { partNumber, title, price, inStock, imageUrl, description } = part;

  return (
    <div className="part-card">
      {imageUrl && (
        <div className="part-card__image">
          <img src={imageUrl} alt={title} />
        </div>
      )}
      <div className="part-card__info">
        <div className="part-card__header">
          <span className="part-card__part-number">{partNumber}</span>
          <span className={`part-card__stock ${inStock ? 'in-stock' : 'out-of-stock'}`}>
            {inStock ? 'In Stock' : 'Out of Stock'}
          </span>
        </div>
        <h3 className="part-card__title">{title}</h3>
        {price && <div className="part-card__price">{price}</div>}
        {description && (
          <p className="part-card__description">{description}</p>
        )}
        <a
          href={`https://www.partselect.com/${partNumber}.htm`}
          target="_blank"
          rel="noopener noreferrer"
          className="part-card__link"
        >
          View on PartSelect
        </a>
      </div>
    </div>
  );
}

export default PartCard;
