variable "name" {
  description = "Name prefix for VPC resources"
  type        = string
}

variable "cidr" {
  description = "CIDR block for the VPC"
  type        = string
}

variable "azs" {
  description = "Availability zones to spread subnets across"
  type        = list(string)
}

variable "tags" {
  description = "Tags applied to every resource"
  type        = map(string)
  default     = {}
}
