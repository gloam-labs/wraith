package nfts

import (
	"context"
	"net/url"
)

// OwnerMetadata is cached metadata for an NFT. Each field can be null.
type OwnerMetadata struct {
	Name     *string `json:"name"`
	TokenURI *string `json:"tokenUri"`
}

// OwnerResponse is the indexed owner and any cached metadata for an NFT.
type OwnerResponse struct {
	Contract string         `json:"contract"`
	TokenID  string         `json:"token_id"`
	Owner    string         `json:"owner"`
	Metadata *OwnerMetadata `json:"metadata"`
}

// Owner returns the owner from the NFT's most recent indexed transfer
// (GET /nfts/owners/{contract}/{token_id}). An unindexed token returns a
// *wraith.APIError with HTTP status 404.
func (n *Client) Owner(ctx context.Context, contract, tokenID string) (*OwnerResponse, error) {
	path := "/nfts/owners/" + url.PathEscape(contract) + "/" + url.PathEscape(tokenID)
	var owner OwnerResponse
	if err := n.c.Get(ctx, path, nil, &owner); err != nil {
		return nil, err
	}
	return &owner, nil
}
